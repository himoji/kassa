/*
 * Payments' OWN mandate scope check (spec §7 T1): active + effective + validity window, order inside
 * scope (payee, category, currency, per-payment cap); period usage is checkMandatePeriod, run under payments' lock. Deliberately independent of
 * mandates/scope.ts used by rules (I2: a logic bug in one must not be shared by the other).
 * (X1) The order must carry a signed obligation link (obligationId + period) to a bill of this user and payee,
 * in the order's currency, for its current period, amount ≤ the bill, category (the obligation's, read here) in
 * the mandate, and the period settled by THIS proposal only (obligation_settlements).
 * Period (UTC): WEEK = ISO 8601 week from Monday; MONTH = calendar month.
 */
import { orderObligation, type CanonicalOrder, type ReasonCode } from "@kassa/shared";
import { and, eq, gte, notInArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { approvals, obligationSettlements, obligations, payments } from "../../db/schema.ts";
import type { mandates } from "../../db/schema.ts";

function periodStartUtc(period: "WEEK" | "MONTH", now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === "MONTH") return new Date(Date.UTC(y, m, 1));
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m, now.getUTCDate() - sinceMonday));
}

export async function checkMandateScope(
  db: DbOrTx,
  m: typeof mandates.$inferSelect,
  order: CanonicalOrder,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: ReasonCode; detail: string }> {
  const t = now.getTime();
  if (m.status !== "ACTIVE" || m.revokedAt) return { ok: false, reason: "MANDATE_INACTIVE", detail: `mandate ${m.status}` };
  if (m.effectiveAt.getTime() > t) return { ok: false, reason: "MANDATE_INACTIVE", detail: "mandate not yet effective" };
  if (m.validFrom.getTime() > t || (m.validUntil && m.validUntil.getTime() <= t)) {
    return { ok: false, reason: "MANDATE_INACTIVE", detail: "outside mandate validity" };
  }
  if (!m.payeeIds.includes(order.payeeId)) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "payee not in mandate" };
  // X1: the bill this payment is for, read from payments' own query of the obligation (category included).
  let link: ReturnType<typeof orderObligation>;
  try {
    link = orderObligation(order);
  } catch {
    link = null;
  }
  if (!link) return { ok: false, reason: "MANDATE_SCOPE_MISMATCH", detail: "mandate payment not linked to an obligation" };
  const ob = (await db.select().from(obligations).where(eq(obligations.id, link.obligationId)))[0];
  if (!ob || ob.userId !== order.userId || ob.payeeId !== order.payeeId) {
    return { ok: false, reason: "MANDATE_SCOPE_MISMATCH", detail: "obligation is not this user's bill for this payee" };
  }
  if (ob.currency !== order.currency || order.amountMinor > ob.amountMinor) {
    return { ok: false, reason: "MANDATE_SCOPE_MISMATCH", detail: "amount above the bill or currency differs" };
  }
  if (link.period !== ob.dueDate) return { ok: false, reason: "MANDATE_SCOPE_MISMATCH", detail: "not the obligation's current period" };
  if (!m.categories.includes(ob.category)) return { ok: false, reason: "MANDATE_SCOPE_MISMATCH", detail: "obligation category not in mandate" };
  const settlement = (
    await db
      .select()
      .from(obligationSettlements)
      .where(and(eq(obligationSettlements.obligationId, ob.id), eq(obligationSettlements.period, link.period)))
  )[0];
  if (!settlement || settlement.proposalId !== order.proposalId) {
    return { ok: false, reason: "DUPLICATE_OBLIGATION_PAYMENT", detail: "period not claimed by this order (already settled or released)" };
  }
  if (m.currency !== order.currency) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "currency differs" };
  if (order.amountMinor > m.maxPerPaymentMinor) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "above per-payment max" };
  return { ok: true };
}

/**
 * The mandate's period maximum: live payments under this mandate in its current period plus this order. Runs inside
 * payments' locked transaction (payments/index.ts step 8, per-user advisory lock), right before the payment row is
 * inserted, so two mandate payments executing at once cannot both pass it (2026-10-18; it ran before the lock).
 */
export async function checkMandatePeriod(
  db: DbOrTx,
  m: typeof mandates.$inferSelect,
  order: CanonicalOrder,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: ReasonCode; detail: string }> {
  const used = await db
    .select({ total: sql<string>`coalesce(sum(${payments.amountMinor}), 0)` })
    .from(payments)
    .innerJoin(approvals, eq(approvals.id, payments.approvalId))
    .where(
      and(
        eq(approvals.mandateId, m.id),
        notInArray(payments.status, ["FAILED", "CANCELED"]),
        gte(payments.createdAt, periodStartUtc(m.period, now)),
      ),
    );
  if (Number(used[0]?.total ?? 0) + order.amountMinor > m.maxPerPeriodMinor) {
    return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "period maximum reached" };
  }
  return { ok: true };
}
