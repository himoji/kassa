/*
 * Mandate scope for the RULES side (spec §10 step 7). Payments has its own independent check
 * (payments/mandateScope.ts) — deliberately duplicated, not shared (I2).
 *
 * Periods (UTC): WEEK = ISO 8601 week starting Monday 00:00; MONTH = calendar month.
 */
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { approvals, mandates, payments } from "../../db/schema.ts";

export function periodStart(period: "WEEK" | "MONTH", now: Date): Date {
  if (period === "MONTH") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const day = now.getUTCDay(); // 0 = Sunday
  const back = (day + 6) % 7; // days since Monday
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
}

export async function mandatePeriodUsage(db: DbOrTx, mandateId: string, period: "WEEK" | "MONTH", now: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${payments.amountMinor}), 0)` })
    .from(payments)
    .innerJoin(approvals, eq(approvals.id, payments.approvalId))
    .where(
      and(
        eq(approvals.mandateId, mandateId),
        notInArray(payments.status, ["FAILED", "CANCELED"]),
        gte(payments.createdAt, periodStart(period, now)),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export type ActiveMandate = typeof mandates.$inferSelect;

/** Active, effective, in-validity, signed mandates of the user. */
export async function activeSignedMandates(db: DbOrTx, userId: string, now: Date): Promise<ActiveMandate[]> {
  const rows = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.userId, userId), inArray(mandates.status, ["ACTIVE"]), isNull(mandates.revokedAt), isNotNull(mandates.userAssertion)));
  return rows.filter(
    (m) =>
      m.effectiveAt.getTime() <= now.getTime() &&
      m.validFrom.getTime() <= now.getTime() &&
      (m.validUntil === null || now.getTime() < m.validUntil.getTime()),
  );
}

/** (X1) The obligation a draft is linked to, as loaded by rules from the DB (never from agent input). */
export type LinkedObligation = { id: string; category: string; amountMinor: number; currency: string; dueDate: string; period: string };

export type MandateMatch = {
  match: ActiveMandate | null;
  /** Linked to an in-scope bill but a cap / currency / period usage is exceeded. */
  outOfScope: boolean;
  /** (X1) A mandate covers this payee but the draft is not linked to a bill in its scope. */
  scopeMismatch: boolean;
};

/**
 * (X1, cn report B5a) A mandate covers only the bills the user signed it for: the draft must be linked server-side
 * to an obligation of this payee whose category is in the mandate, in the order's currency, for its current period
 * (the obligation's due date), with the order amount ≤ the bill. Anything else to a mandate payee is a scope
 * mismatch (→ ASK). A settled period is refused earlier (rules step 1b, DUPLICATE_OBLIGATION_PAYMENT).
 */
export async function findMatchingMandate(
  db: DbOrTx,
  o: { userId: string; payeeId: string; currency: string; amountMinor: number; now: Date; obligation: LinkedObligation | null },
): Promise<MandateMatch> {
  const active = await activeSignedMandates(db, o.userId, o.now);
  const forPayee = active.filter((m) => m.payeeIds.includes(o.payeeId));
  if (forPayee.length === 0) return { match: null, outOfScope: false, scopeMismatch: false };
  const ob = o.obligation;
  const linked = ob !== null && ob.period === ob.dueDate && ob.currency === o.currency && o.amountMinor <= ob.amountMinor;
  if (!linked) return { match: null, outOfScope: false, scopeMismatch: true };
  const coveringCategory = forPayee.filter((m) => m.categories.includes(ob.category));
  if (coveringCategory.length === 0) return { match: null, outOfScope: false, scopeMismatch: true };
  for (const m of coveringCategory) {
    if (m.currency !== o.currency) continue;
    if (o.amountMinor > m.maxPerPaymentMinor) continue;
    const used = await mandatePeriodUsage(db, m.id, m.period, o.now);
    if (used + o.amountMinor > m.maxPerPeriodMinor) continue;
    return { match: m, outOfScope: false, scopeMismatch: false };
  }
  return { match: null, outOfScope: true, scopeMismatch: false };
}
