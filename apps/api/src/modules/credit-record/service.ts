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
 * - BUDGETS (2026-10-19): the user's budget periods that overlap the period, and how many stayed within their limit
 *   (spending to the issue day for a period still running);
 * - PAYMENTS (2026-10-19): payments completed (SENT) in the period, own-balance conversions excluded, and of those that
 *   paid a bill, the share sent by the bill's due date.
 * A bill paid early (its due date after the period) counts once its payment was sent inside the period.
 * (v3, 2026-10-19) Seeded demo accounts carry a SIMULATED history of the months before (demo/judgeCopy.ts, one
 * ACCOUNT_HISTORY_IMPORTED ledger entry): its bills, payments and incomes count like Kassa's own, its opening day
 * replaces the database row's, and the bundle says so (`importedHistory`, plus `simulated: true` as always).
 * v3 is signed with the credit record key over a domain-separated message (credit-record/keys.ts) and binds the holder:
 * a keyed, salted hash of the full name (KYC-verified when the identity check passed), checked with ?name=.
 * v1 and v2 bundles (issued before) keep verifying: their stored JSON is what was signed, with the ledger key.
 */
import { jcs, jcsHash, type CreditRecordItem } from "@kassa/shared";
import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { budgets, ledgerEntries, obligations, obligationSettlements, payments, users } from "../../db/schema.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { clock, isoDate } from "../clock/index.ts";
import { spentInPeriod } from "../budget/service.ts";
import { accountHistoryOf, type AccountHistory } from "../demo/accountHistory.ts";
import { kycStatusOf } from "../kyc/status.ts";
import { ledger } from "../ledger/index.ts";
import { entryHash } from "../ledger/internal.ts";
import { openPii, sealPii } from "../privacy/keys.ts";
import { holderNameHash, signRecord, verifyRecord } from "./keys.ts";

type Period = { from: string; to: string };

export type CreditSummary = {
  monthsCovered: number;
  /** BUDGETS (v3): budget periods overlapping the period, and those within their limit (to the issue day). */
  budgetsTotal?: number;
  budgetsWithinLimit?: number;
  /** PAYMENTS (v3): payments completed in the period; of those that paid a bill, % sent by its due date. */
  paymentsCompleted?: number;
  paymentsOnTimePct?: number;
  /** BILLS: bill periods due in the period, and those paid by their due date. */
  billsTotal?: number;
  billsPaidOnTime?: number;
  /** INCOME (v2): calendar months with incoming money observed by Kassa. */
  incomeMonths?: number;
  /** v1 only (declared income, not evidence): kept so old records still render. */
  regularIncomeMonths?: number;
};

export type CreditBundle = {
  v: 1 | 2 | 3;
  verifyId: string;
  issuedAt: string;
  /** The period the figures cover (v2: clamped to the account's life). */
  period: Period;
  /** v2: the period the holder asked for. */
  requestedPeriod?: Period;
  /** v2: the day the account was opened (UTC). */
  accountOpenedOn?: string;
  holder: string;
  /** v3: the holder's full name, keyed and salted (credit-record/keys.ts holderNameHash); KYC = identity-checked name. */
  holderName?: { source: "KYC" | "PROFILE"; salt: string; hmac: string };
  /** v3: figures include a simulated history imported when the demo account was seeded (demo/judgeCopy.ts). */
  importedHistory?: { source: "seed"; simulated: true; openedOn: string };
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

type BillPayment = { period: string; paidAtMs: number };

/**
 * Bill payments Kassa observed: each PAID settlement whose payment was SENT (when), plus the imported history's bills.
 * Keyed by obligation and period.
 */
async function billPayments(userId: string, history: AccountHistory | null): Promise<Map<string, BillPayment>> {
  const db = getDb();
  const paid = await db
    .select({ obligationId: obligationSettlements.obligationId, period: obligationSettlements.period, proposalId: obligationSettlements.proposalId })
    .from(obligationSettlements)
    .where(and(eq(obligationSettlements.userId, userId), eq(obligationSettlements.status, "PAID")));
  const ids = paid.map((s) => s.proposalId);
  const sent = ids.length
    ? await db
        .select({ proposalId: payments.proposalId, updatedAt: payments.updatedAt })
        .from(payments)
        .where(and(inArray(payments.proposalId, ids), eq(payments.status, "SENT")))
    : [];
  const sentAt = new Map(sent.map((r) => [r.proposalId, r.updatedAt.getTime()]));
  const out = new Map<string, BillPayment>();
  for (const h of history?.bills ?? []) out.set(`${h.obligationId}|${h.period}`, { period: h.period, paidAtMs: dayStart(h.paidOn).getTime() });
  for (const s of paid) {
    const at = sentAt.get(s.proposalId);
    if (at !== undefined) out.set(`${s.obligationId}|${s.period}`, { period: s.period, paidAtMs: at });
  }
  return out;
}

const onTime = (b: BillPayment) => b.paidAtMs <= dayEnd(b.period).getTime();
const inPeriod = (ms: number, p: Period) => ms >= dayStart(p.from).getTime() && ms <= dayEnd(p.to).getTime();

/**
 * BILLS: bill periods that fell due in `p`, and how many were paid by the end of their due day; plus bills paid early
 * inside `p` whose due date is after it (paid on time by definition).
 */
async function billFigures(userId: string, p: Period, today: string, paidBills: Map<string, BillPayment>): Promise<{ billsTotal: number; billsPaidOnTime: number }> {
  const db = getDb();
  const settled = await db
    .select({ obligationId: obligationSettlements.obligationId, period: obligationSettlements.period, status: obligationSettlements.status })
    .from(obligationSettlements)
    .where(and(eq(obligationSettlements.userId, userId), gte(obligationSettlements.period, p.from), lte(obligationSettlements.period, p.to)));
  // A bill still open at its own due date (no settlement, or one only pending) counts once it is past due.
  const open = await db
    .select({ id: obligations.id, dueDate: obligations.dueDate })
    .from(obligations)
    .where(and(eq(obligations.userId, userId), gte(obligations.dueDate, p.from), lte(obligations.dueDate, p.to)));
  const due = new Map<string, boolean>();
  for (const [key, b] of paidBills) {
    if (b.period >= p.from && b.period <= p.to) due.set(key, onTime(b));
    else if (b.period > p.to && inPeriod(b.paidAtMs, p)) due.set(key, true);
  }
  for (const s of settled) {
    const key = `${s.obligationId}|${s.period}`;
    if (!due.has(key) && (s.status === "PAID" || s.period < today)) due.set(key, false);
  }
  for (const o of open) {
    const key = `${o.id}|${o.dueDate}`;
    if (!due.has(key) && o.dueDate < today) due.set(key, false);
  }
  return { billsTotal: due.size, billsPaidOnTime: [...due.values()].filter(Boolean).length };
}

/** PAYMENTS: payments completed (SENT) in `p` (conversions between own balances excluded) and bill payments' on-time share. */
async function paymentFigures(userId: string, p: Period, paidBills: Map<string, BillPayment>, history: AccountHistory | null): Promise<{ paymentsCompleted: number; paymentsOnTimePct?: number }> {
  const rows = await getDb()
    .select({ n: sql<string>`count(*)` })
    .from(payments)
    .where(and(eq(payments.userId, userId), eq(payments.status, "SENT"), ne(payments.rail, "CONVERT"), gte(payments.updatedAt, dayStart(p.from)), lte(payments.updatedAt, dayEnd(p.to))));
  const imported = (history?.bills ?? []).filter((b) => inPeriod(dayStart(b.paidOn).getTime(), p)).length;
  const bills = [...paidBills.values()].filter((b) => inPeriod(b.paidAtMs, p));
  return {
    paymentsCompleted: Number(rows[0]?.n ?? 0) + imported,
    ...(bills.length ? { paymentsOnTimePct: Math.round((100 * bills.filter(onTime).length) / bills.length) } : {}),
  };
}

/** BUDGETS: the budget periods overlapping `p`, and how many stayed within their limit (to `today` while running). */
async function budgetFigures(userId: string, p: Period, today: string): Promise<{ budgetsTotal: number; budgetsWithinLimit: number }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.userId, userId), lte(budgets.periodStart, p.to), gte(budgets.periodEnd, p.from), lte(budgets.periodStart, today)));
  let kept = 0;
  for (const b of rows) {
    const spent = await spentInPeriod(db, userId, b.category, b.periodStart, b.periodEnd < today ? b.periodEnd : today);
    if (spent <= b.limitHomeMinor) kept++;
  }
  return { budgetsTotal: rows.length, budgetsWithinLimit: kept };
}

/** INCOME: calendar months (UTC) in `p` with at least one incoming transfer recorded in the ledger (or imported). */
async function incomeMonths(userId: string, p: Period, history: AccountHistory | null): Promise<number> {
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
  const months = new Set(rows.map((r) => r.ts.toISOString().slice(0, 7)));
  for (const i of history?.incomes ?? []) if (i.on >= p.from && i.on <= p.to) months.add(i.on.slice(0, 7));
  return months.size;
}

export async function exportCreditRecord(userId: string, req: { from: string; to: string; items: CreditRecordItem[] }) {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw notFound("user");
  const today = isoDate(clock.now());
  const history = await accountHistoryOf(userId);
  // users.created_at is the database's wall time; on the demo clock "today" may be earlier: never later than today.
  // An imported (seeded) history brings its own, earlier opening day.
  const created = isoDate(u.createdAt);
  const opened = history && history.openedOn < created ? history.openedOn : created;
  const openedOn = opened < today ? opened : today;
  const period = clampPeriod(req, openedOn, today);
  const items = [...new Set(req.items)].sort();
  const summary: CreditSummary = { monthsCovered: monthsBetween(period.from, period.to) };
  const paidBills = items.includes("BILLS") || items.includes("PAYMENTS") ? await billPayments(userId, history) : new Map<string, BillPayment>();
  if (items.includes("BILLS")) Object.assign(summary, await billFigures(userId, period, today, paidBills));
  if (items.includes("INCOME")) summary.incomeMonths = await incomeMonths(userId, period, history);
  if (items.includes("BUDGETS")) Object.assign(summary, await budgetFigures(userId, period, today));
  if (items.includes("PAYMENTS")) Object.assign(summary, await paymentFigures(userId, period, paidBills, history));
  const salt = randomBytes(16).toString("base64url");
  const bundle: CreditBundle = {
    v: 3,
    verifyId: randomBytes(16).toString("base64url"),
    issuedAt: clock.now().toISOString(),
    period,
    requestedPeriod: { from: req.from, to: req.to },
    accountOpenedOn: openedOn,
    holder: initials(u.displayName),
    holderName: { source: (await kycStatusOf(db, userId)) === "VERIFIED" ? "KYC" : "PROFILE", salt, hmac: holderNameHash(u.displayName, salt) },
    ...(history ? { importedHistory: { source: "seed" as const, simulated: true as const, openedOn: history.openedOn } } : {}),
    items,
    summary,
    simulated: true,
  };
  const sha256 = jcsHash(bundle);
  const { sig, keyId } = signRecord(sha256);
  // The bundle (holder initials, payment history summary) is sealed with the user's key: after an erasure
  // (GDPR Art. 17) the public verify link stops resolving while the ledger chain stays intact.
  await ledger.append("CREDIT_RECORD_EXPORTED", { userId, verifyId: bundle.verifyId, sha256, sig, keyId, ...(await sealPii(userId, { bundle })) });
  return { bundle, sha256 };
}

/** v3: does `name` match the bundle's holder? null when the bundle binds no name (v1/v2). */
export function holderNameMatches(bundle: CreditBundle, name: string): boolean | null {
  if (!bundle.holderName) return null;
  return holderNameHash(name, bundle.holderName.salt) === bundle.holderName.hmac;
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
  const valid =
    jcsHash(payload.bundle) === payload.sha256 &&
    verifyRecord(payload.bundle.v, payload.sha256, payload.sig, payload.keyId) &&
    entryHash(e.prevHash, e.seq, e.ts.toISOString(), e.type, e.payload) === e.hash;
  return { ...payload, valid, json: jcs(payload.bundle) };
}
