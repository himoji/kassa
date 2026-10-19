/*
 * Credit record (spec §8, §16): a signed summary the student can share with a landlord or bank.
 * bundle → sha256 = base64url(sha256(JCS(bundle))) → Ed25519 signature with LEDGER_CHECKPOINT_KEY
 * (RFC 8032) → stored in the append-only ledger (I12) under an unguessable verifyId (128-bit random).
 * Public verification recomputes the hash, checks the signature and the ledger chain.
 *
 * (v2, security review 2026-10-18) Only what Kassa itself observed is signed, and only for the selected items:
 * - the period is clamped to the account's life: it starts no earlier than the day the account was opened and ends no
 *   later than today; the requested period and the opening day are in the bundle, so a reader sees the clamp;
 * - BILLS: the bill periods that fell due in the period (obligation_settlements and still-unpaid obligations), and how
 *   many were paid by their due date (the payment SENT by the end of the due day). Proposals that never claimed a
 *   bill (refused, duplicates) do not count;
 * - INCOME: calendar months in which money came in (money from home, a transfer from another Kassa user), from the
 *   ledger; a declared income in the profile is not evidence;
 * - monthsCovered: calendar months the (clamped) period touches; always present.
 * BUDGETS and PAYMENTS add no summary figure (yet): they are listed as selected and nothing else is shared.
 * v1 bundles (issued before) keep verifying: their stored JSON is what was signed.
 */
import { jcs, jcsHash, type CreditRecordItem } from "@kassa/shared";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { ledgerEntries, obligations, obligationSettlements, payments, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { clock, isoDate } from "../clock/index.ts";
import { checkpointPublicKey, ledger } from "../ledger/index.ts";
import { entryHash } from "../ledger/internal.ts";
import { keyIdOf, loadPrivateKey, signText, verifyText } from "../ledger/keys.ts";
import { openPii, sealPii } from "../privacy/keys.ts";

type Period = { from: string; to: string };

export type CreditSummary = {
  monthsCovered: number;
  /** BILLS: bill periods due in the period, and those paid by their due date. */
  billsTotal?: number;
  billsPaidOnTime?: number;
  /** INCOME (v2): calendar months with incoming money observed by Kassa. */
  incomeMonths?: number;
  /** v1 only (declared income, not evidence): kept so old records still render. */
  regularIncomeMonths?: number;
};

export type CreditBundle = {
  v: 1 | 2;
  verifyId: string;
  issuedAt: string;
  /** The period the figures cover (v2: clamped to the account's life). */
  period: Period;
  /** v2: the period the holder asked for. */
  requestedPeriod?: Period;
  /** v2: the day the account was opened (UTC). */
  accountOpenedOn?: string;
  holder: string;
  items: CreditRecordItem[];
  summary: CreditSummary;
  simulated: boolean;
};

/** Ledger entries that record money coming in to the user (webhooks/routes.ts). */
const INCOMING_TYPES = ["TRIGGER_REMITTANCE", "WALLET_RECEIVED"];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join(" ");
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999Z`);

/** The requested period clamped to [account opened, today]. 422 when nothing of it lies in the account's life. */
export function clampPeriod(req: Period, openedOn: string, today: string): Period {
  const from = req.from < openedOn ? openedOn : req.from;
  const to = req.to > today ? today : req.to;
  if (from > to) {
    throw new HttpProblem(422, "PERIOD_OUTSIDE_ACCOUNT", `The period must overlap the account's life (opened ${openedOn}, today ${today})`, {
      details: { accountOpenedOn: openedOn, today },
    });
  }
  return { from, to };
}

/** BILLS: bill periods that fell due in `p` (or were paid) and how many were paid by the end of their due day. */
async function billFigures(userId: string, p: Period, today: string): Promise<{ billsTotal: number; billsPaidOnTime: number }> {
  const db = getDb();
  const settled = await db
    .select({ obligationId: obligationSettlements.obligationId, period: obligationSettlements.period, status: obligationSettlements.status, proposalId: obligationSettlements.proposalId })
    .from(obligationSettlements)
    .where(and(eq(obligationSettlements.userId, userId), gte(obligationSettlements.period, p.from), lte(obligationSettlements.period, p.to)));
  // A bill still open at its own due date (no settlement, or one only pending) counts once it is past due.
  const open = await db
    .select({ id: obligations.id, dueDate: obligations.dueDate })
    .from(obligations)
    .where(and(eq(obligations.userId, userId), gte(obligations.dueDate, p.from), lte(obligations.dueDate, p.to)));
  const due = new Map<string, { period: string; proposalId: string | null; paid: boolean }>();
  for (const s of settled) {
    if (s.status === "PAID" || s.period < today) due.set(`${s.obligationId}|${s.period}`, { period: s.period, proposalId: s.proposalId, paid: s.status === "PAID" });
  }
  for (const o of open) {
    const key = `${o.id}|${o.dueDate}`;
    if (!due.has(key) && o.dueDate < today) due.set(key, { period: o.dueDate, proposalId: null, paid: false });
  }
  const paidIds = [...due.values()].filter((d) => d.paid && d.proposalId).map((d) => d.proposalId!);
  const sent = paidIds.length
    ? await db
        .select({ proposalId: payments.proposalId, updatedAt: payments.updatedAt })
        .from(payments)
        .where(and(inArray(payments.proposalId, paidIds), eq(payments.status, "SENT")))
    : [];
  const sentAt = new Map(sent.map((r) => [r.proposalId, r.updatedAt.getTime()]));
  let onTime = 0;
  for (const d of due.values()) {
    const at = d.proposalId ? sentAt.get(d.proposalId) : undefined;
    if (at !== undefined && at <= dayEnd(d.period).getTime()) onTime++;
  }
  return { billsTotal: due.size, billsPaidOnTime: onTime };
}

/** INCOME: calendar months (UTC) in `p` with at least one incoming transfer recorded in the ledger. */
async function incomeMonths(userId: string, p: Period): Promise<number> {
  const rows = await getDb()
    .select({ ts: ledgerEntries.ts })
    .from(ledgerEntries)
    .where(
      and(
        inArray(ledgerEntries.type, INCOMING_TYPES),
        sql`${ledgerEntries.payload}->>'userId' = ${userId}`,
        gte(ledgerEntries.ts, dayStart(p.from)),
        lte(ledgerEntries.ts, dayEnd(p.to)),
      ),
    );
  return new Set(rows.map((r) => r.ts.toISOString().slice(0, 7))).size;
}

export async function exportCreditRecord(userId: string, req: { from: string; to: string; items: CreditRecordItem[] }) {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw notFound("user");
  const today = isoDate(clock.now());
  // users.created_at is the database's wall time; on the demo clock "today" may be earlier: never later than today.
  const created = isoDate(u.createdAt);
  const openedOn = created < today ? created : today;
  const period = clampPeriod(req, openedOn, today);
  const items = [...new Set(req.items)].sort();
  const summary: CreditSummary = { monthsCovered: monthsBetween(period.from, period.to) };
  if (items.includes("BILLS")) Object.assign(summary, await billFigures(userId, period, today));
  if (items.includes("INCOME")) summary.incomeMonths = await incomeMonths(userId, period);
  const bundle: CreditBundle = {
    v: 2,
    verifyId: randomBytes(16).toString("base64url"),
    issuedAt: clock.now().toISOString(),
    period,
    requestedPeriod: { from: req.from, to: req.to },
    accountOpenedOn: openedOn,
    holder: initials(u.displayName),
    items,
    summary,
    simulated: true,
  };
  const sha256 = jcsHash(bundle);
  const key = loadPrivateKey(env().LEDGER_CHECKPOINT_KEY);
  const pub = checkpointPublicKey();
  const sig = signText(key, sha256);
  // The bundle (holder initials, payment history summary) is sealed with the user's key: after an erasure
  // (GDPR Art. 17) the public verify link stops resolving while the ledger chain stays intact.
  await ledger.append("CREDIT_RECORD_EXPORTED", { userId, verifyId: bundle.verifyId, sha256, sig, keyId: keyIdOf(pub), ...(await sealPii(userId, { bundle })) });
  return { bundle, sha256 };
}

export async function findCreditRecord(verifyId: string) {
  const db = getDb();
  const e = (
    await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.type, "CREDIT_RECORD_EXPORTED"), sql`${ledgerEntries.payload}->>'verifyId' = ${verifyId}`))
  )[0];
  if (!e) throw notFound("credit record");
  const raw = e.payload as { userId: string; bundle?: CreditBundle; pii?: string; sha256: string; sig: string; keyId: string };
  // Pre-Phase-2 entries carry the bundle in clear; newer ones seal it with the holder's key.
  const opened = raw.pii ? ((await openPii(raw.userId, raw.pii, db)) as { bundle: CreditBundle } | null) : raw.bundle ? { bundle: raw.bundle } : null;
  if (!opened) throw new HttpProblem(410, "ACCOUNT_ERASED", "This credit record was withdrawn: the holder erased their data", { reasonCodes: ["ACCOUNT_ERASED"] });
  const payload = { ...raw, bundle: opened.bundle };
  const pub = checkpointPublicKey();
  const valid =
    jcsHash(payload.bundle) === payload.sha256 &&
    payload.keyId === keyIdOf(pub) &&
    verifyText(pub, payload.sha256, payload.sig) &&
    entryHash(e.prevHash, e.seq, e.ts.toISOString(), e.type, e.payload) === e.hash;
  return { ...payload, valid, json: jcs(payload.bundle) };
}
