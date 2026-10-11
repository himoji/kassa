/*
 * Payments' OWN mandate scope check (spec §7 T1): active + effective + validity window, order inside
 * scope (payee, category, currency, per-payment cap) and period usage. Deliberately independent of
 * mandates/scope.ts used by rules (I2: a logic bug in one must not be shared by the other).
 * Period (UTC): WEEK = ISO 8601 week from Monday; MONTH = calendar month.
 */
import type { CanonicalOrder, ReasonCode } from "@kassa/shared";
import { and, eq, gte, notInArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { approvals, payments } from "../../db/schema.ts";
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
  category: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: ReasonCode; detail: string }> {
  const t = now.getTime();
  if (m.status !== "ACTIVE" || m.revokedAt) return { ok: false, reason: "MANDATE_INACTIVE", detail: `mandate ${m.status}` };
  if (m.effectiveAt.getTime() > t) return { ok: false, reason: "MANDATE_INACTIVE", detail: "mandate not yet effective" };
  if (m.validFrom.getTime() > t || (m.validUntil && m.validUntil.getTime() <= t)) {
    return { ok: false, reason: "MANDATE_INACTIVE", detail: "outside mandate validity" };
  }
  if (!m.payeeIds.includes(order.payeeId)) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "payee not in mandate" };
  if (!m.categories.includes(category)) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "category not in mandate" };
  if (m.currency !== order.currency) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "currency differs" };
  if (order.amountMinor > m.maxPerPaymentMinor) return { ok: false, reason: "MANDATE_OUT_OF_SCOPE", detail: "above per-payment max" };
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
