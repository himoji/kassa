/*
 * In-process scheduler (spec §15): every 15 s, driven by the Clock.
 *  - obligations due within 3 days → proposal (createdBy=SCHEDULER), skipped when the period is already
 *    pending or paid (obligation_settlements, B4) and tried once per (obligation, dueDate);
 *    a MONTHLY obligation rolls to next month once its period is paid;
 *  - signed rule changes / mandates reaching effectiveAt → apply;
 *  - card expiry → cancel unused cards;
 *  - mock bank status progression → poll PROCESSING transfers (webhooks also push changes);
 *  - digest → Track B budget.sendDigestIfDue(userId) when exported;
 *  - signed unfreezes reaching effectiveAt → lift the freeze (I8);
 *  - retention purge (GDPR Art. 5(1)(e), RETENTION_DAYS_*), at most hourly on the clock;
 *  - webhook seen-signature purge (I13 replay store): entries whose timestamp is outside the window.
 *  - revoked-token purge (R13): spent or logged-out session JWTs past their own expiry (wall time);
 *  - rate-limit counter purge (R13): counters whose window has ended.
 *  - business.forecastTick (Business M4): stock short by the end of tomorrow → DRAFT purchase order + owner
 *    notification, once per (merchant, SKU, day); drafts only, never signs or pays (I6).
 *  - ledgerAnchor (2026-10-19): with ANCHOR_PRIVATE_KEY, the newest signed checkpoint on a public testnet, at most once
 *    per ANCHOR_INTERVAL_MINUTES for the deployment (ledger/autoAnchor.ts). Last: it waits for the transaction to mine.
 * Each job is isolated: one failing job never stops the others.
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { obligations, payments, proposals, users } from "../../db/schema.ts";
import { purgeRateLimitCounters } from "../../http/rate-limit-store.ts";
import { clock } from "../clock/index.ts";
import { forecastTick } from "../business/scheduler.ts";
import { purgeRevokedTokens } from "../auth/revocation.ts";
import { autoAnchorTick } from "../ledger/autoAnchor.ts";
import { ledger } from "../ledger/index.ts";
import { activateDueMandates } from "../mandates/service.ts";
import { settlementFor } from "../obligations/settlements.ts";
import { updatePaymentStatus } from "../payments/status.ts";
import { expireCards } from "../rails/issuing.ts";
import { getTransferStatus } from "../rails/mockBank.ts";
import { proposeOrder, type ProposeOrderResult } from "../rules/index.ts";
import { purgeIfDue } from "../privacy/service.ts";
import { applyDueRuleChanges } from "../users/settings.ts";
import { applyDueUnfreezes } from "../users/unfreeze.ts";
import { purgeSeenWebhookSignatures } from "../webhooks/replay.ts";
import { addMonths, dueHorizon } from "./window.ts";

export const TICK_MS = 15_000;
/** The due window lives in ./window.ts (shared with the rules and payments mandate checks). */
export { DUE_WINDOW_DAYS } from "./window.ts";

export { addMonths } from "./window.ts";

/** What one due-bills pass did with one bill inside the window (scheduler job and the demo's own-copy run). */
export type DueObligationOutcome = {
  obligationId: string;
  category: string;
  dueDate: string;
  /** PROPOSED = a proposal now (see decision); PAID / PENDING = the period was already paid / awaiting approval; TRIED = the scheduler already proposed it once. */
  outcome: "PROPOSED" | "PAID" | "PENDING" | "TRIED";
  proposal?: ProposeOrderResult;
};

/**
 * Bills due within the window (scheduler/window.ts) → one proposal each. `userId` limits the pass to one user (the
 * demo's "run today's scheduled payments" on a reviewer's own copy); the date is always the Clock's, never an override.
 */
export async function proposeDue(opts: { userId?: string } = {}): Promise<DueObligationOutcome[]> {
  const db = getDb();
  const now = clock.now();
  const horizon = dueHorizon(now);
  const inWindow = lte(obligations.dueDate, horizon);
  const due = await db
    .select()
    .from(obligations)
    .where(opts.userId ? and(inWindow, eq(obligations.userId, opts.userId)) : inWindow);
  const out: DueObligationOutcome[] = [];
  for (const o of due) {
    const base = { obligationId: o.id, category: o.category, dueDate: o.dueDate };
    // B4: one settlement per (obligation, period). Pending or paid (by the agent or by an earlier tick): skip;
    // a MONTHLY obligation rolls to the next period once this one is paid.
    const settled = await settlementFor(db, o.id, o.dueDate);
    if (settled) {
      if (settled.status === "PAID" && o.recurrence === "MONTHLY") {
        const next = addMonths(o.dueDate, 1);
        await db.update(obligations).set({ dueDate: next }).where(eq(obligations.id, o.id));
        await ledger.append("OBLIGATION_ROLLED", { userId: o.userId, obligationId: o.id, from: o.dueDate, to: next });
      }
      out.push({ ...base, outcome: settled.status === "PAID" ? "PAID" : "PENDING" });
      continue;
    }
    // One scheduler attempt per period: a refused or rejected scheduler proposal is not re-proposed every tick.
    const tried = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(and(eq(proposals.obligationId, o.id), eq(proposals.createdBy, "SCHEDULER"), sql`${proposals.draft}->>'dueDate' = ${o.dueDate}`));
    if (tried.length > 0) {
      out.push({ ...base, outcome: "TRIED" });
      continue;
    }
    const proposal = await proposeOrder({
      userId: o.userId,
      createdBy: "SCHEDULER",
      payeeId: o.payeeId,
      amountMinor: o.amountMinor,
      currency: o.currency,
      purpose: (o.reference ? `${o.category} ${o.reference}` : `${o.category} due ${o.dueDate}`).slice(0, 140),
      category: o.category,
      obligationId: o.id,
      dueDate: o.dueDate,
    });
    out.push({ ...base, outcome: "PROPOSED", proposal });
  }
  return out;
}

/** Scheduler job: every user's due bills; returns how many proposals were made. */
export async function proposeDueObligations(): Promise<number> {
  return (await proposeDue()).filter((r) => r.outcome === "PROPOSED").length;
}

export async function pollBankTransfers(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.rail, "BANK_TRANSFER"), inArray(payments.status, ["CREATED", "PROCESSING"])));
  let changed = 0;
  for (const p of rows) {
    if (!p.railRef) continue;
    try {
      const status = await getTransferStatus(p.railRef);
      if (status !== p.status && (await updatePaymentStatus(p.id, status, { source: "scheduler:mock-bank-poll" }))) changed++;
    } catch {
      // mock bank unreachable: try again next tick
    }
  }
  return changed;
}

type BudgetModule = { sendDigestIfDue?: (userId: string) => Promise<unknown> };
async function sendDigests(): Promise<void> {
  let mod: BudgetModule = {};
  try {
    const path = new URL("../budget/index.ts", import.meta.url).href;
    mod = (await import(/* @vite-ignore */ path)) as BudgetModule;
  } catch {
    return;
  }
  if (!mod.sendDigestIfDue) return;
  // Erased (GDPR Art. 17) and restricted (Art. 18) accounts get no further processing.
  for (const u of await getDb().select({ id: users.id }).from(users).where(and(isNull(users.erasedAt), isNull(users.restrictedAt)))) await mod.sendDigestIfDue(u.id);
}

const JOBS: [string, () => Promise<unknown>][] = [
  ["ruleChanges", applyDueRuleChanges],
  ["unfreeze", applyDueUnfreezes],
  ["mandates", activateDueMandates],
  ["obligations", proposeDueObligations],
  ["cardExpiry", expireCards],
  ["bankPoll", pollBankTransfers],
  ["digest", sendDigests],
  ["retention", purgeIfDue],
  ["webhookReplayPurge", () => purgeSeenWebhookSignatures()],
  ["revokedTokenPurge", () => purgeRevokedTokens()],
  ["rateLimitPurge", () => purgeRateLimitCounters()],
  ["business.forecastTick", () => forecastTick()],
  ["ledgerAnchor", () => autoAnchorTick()],
];

let running = false;

/** One scheduler pass. Re-entrancy guarded: a slow tick is never overlapped. */
export async function tick(log: (msg: string, err?: unknown) => void = () => undefined): Promise<void> {
  if (running) return;
  running = true;
  try {
    await clock.load();
    for (const [name, job] of JOBS) {
      try {
        await job();
      } catch (err) {
        log(`scheduler job ${name} failed`, err);
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduler(log: (msg: string, err?: unknown) => void): () => void {
  const timer = setInterval(() => void tick(log), TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
