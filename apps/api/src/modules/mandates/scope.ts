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

export async function findMatchingMandate(
  db: DbOrTx,
  o: { userId: string; payeeId: string; category: string; currency: string; amountMinor: number; now: Date },
): Promise<{ match: ActiveMandate | null; outOfScope: boolean }> {
  const active = await activeSignedMandates(db, o.userId, o.now);
  const forPayee = active.filter((m) => m.payeeIds.includes(o.payeeId));
  for (const m of forPayee) {
    if (!m.categories.includes(o.category)) continue;
    if (m.currency !== o.currency) continue;
    if (o.amountMinor > m.maxPerPaymentMinor) continue;
    const used = await mandatePeriodUsage(db, m.id, m.period, o.now);
    if (used + o.amountMinor > m.maxPerPeriodMinor) continue;
    return { match: m, outOfScope: false };
  }
  return { match: null, outOfScope: forPayee.length > 0 };
}
