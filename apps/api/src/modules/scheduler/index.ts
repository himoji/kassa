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
 * Each job is isolated: one failing job never stops the others.
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { obligations, payments, proposals, users } from "../../db/schema.ts";
import { addMs, clock, DAY_MS, isoDate } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { activateDueMandates } from "../mandates/service.ts";
import { settlementFor } from "../obligations/settlements.ts";
import { updatePaymentStatus } from "../payments/status.ts";
import { expireCards } from "../rails/issuing.ts";
import { getTransferStatus } from "../rails/mockBank.ts";
import { proposeOrder } from "../rules/index.ts";
import { purgeIfDue } from "../privacy/service.ts";
import { applyDueRuleChanges } from "../users/settings.ts";
import { applyDueUnfreezes } from "../users/unfreeze.ts";
import { purgeSeenWebhookSignatures } from "../webhooks/replay.ts";

export const TICK_MS = 15_000;
export const DUE_WINDOW_DAYS = 3;

/** ISO 8601 date + n calendar months, day clamped to the month's length. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return isoDate(target);
}

export async function proposeDueObligations(): Promise<number> {
  const db = getDb();
  const now = clock.now();
  const horizon = isoDate(addMs(now, DUE_WINDOW_DAYS * DAY_MS));
  const due = await db.select().from(obligations).where(lte(obligations.dueDate, horizon));
  let created = 0;
  for (const o of due) {
    // B4: one settlement per (obligation, period). Pending or paid (by the agent or by an earlier tick): skip;
    // a MONTHLY obligation rolls to the next period once this one is paid.
    const settled = await settlementFor(db, o.id, o.dueDate);
    if (settled) {
      if (settled.status === "PAID" && o.recurrence === "MONTHLY") {
        const next = addMonths(o.dueDate, 1);
        await db.update(obligations).set({ dueDate: next }).where(eq(obligations.id, o.id));
        await ledger.append("OBLIGATION_ROLLED", { userId: o.userId, obligationId: o.id, from: o.dueDate, to: next });
      }
      continue;
    }
    // One scheduler attempt per period: a refused or rejected scheduler proposal is not re-proposed every tick.
    const tried = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(and(eq(proposals.obligationId, o.id), eq(proposals.createdBy, "SCHEDULER"), sql`${proposals.draft}->>'dueDate' = ${o.dueDate}`));
    if (tried.length > 0) continue;
    await proposeOrder({
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
    created++;
  }
  return created;
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
