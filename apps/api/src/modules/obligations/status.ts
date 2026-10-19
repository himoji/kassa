/*
 * (added 2026-10-19) Where a bill's current period stands, from its settlement record (obligation_settlements, B4) and
 * the order and payment that hold it. One answer for GET /obligations, the coverage forecast (fx/index.ts) and the
 * planner's get_obligations, so none of them calls a paid bill due again (a judge saw rent and tuition paid, then
 * listed as "still to pay", and the forecast take the money a second time on the due date).
 *
 *   DUE                no order holds the period (or the last one was rejected / failed: its claim was released);
 *   AWAITING_APPROVAL  an order for the period waits for the user's passkey: no money has moved;
 *   IN_FLIGHT          the order is approved and its payment created, not yet delivered (PROCESSING);
 *   PAID               the payment was delivered (SENT).
 *
 * A settled period (`settled`) no longer counts as money to come out of the wallet: IN_FLIGHT bank transfers have
 * already been debited (the bank funds a transfer from the balance when it is created), PAID ones are done. An
 * IN_FLIGHT payment on another rail (a handoff QR the user still has to pay, a one-time card not yet charged) still
 * counts. Recurring bills then continue with their next period (`nextDueDate`); the scheduler moves the stored due
 * date when it gets there (scheduler/index.ts).
 */
import type { ObligationPeriodStatus, PaymentStatus } from "@kassa/shared";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { obligationSettlements, payments, proposals } from "../../db/schema.ts";
import { addMonths } from "../fx/forecast.ts";

export interface ObligationPeriodState {
  status: ObligationPeriodStatus;
  /** The period (due date) this status is for: the bill's stored due date. */
  period: string;
  proposalId: string | null;
  paymentId: string | null;
  paymentStatus: PaymentStatus | null;
  /** When the payment was delivered (RFC 3339), for PAID. */
  paidAt: string | null;
  /** The money of this period has left (or is leaving) the wallet: coverage and forecast skip the period. */
  settled: boolean;
  /** Recurring and settled: the due date of the next period (MONTHLY + 1 month, TERM + 4 months); else null. */
  nextDueDate: string | null;
}

/** The next period's due date of a recurring bill (TERM as the forecast counts it, fx/forecast.ts occurrences). */
export function nextPeriod(dueDate: string, recurrence: string): string | null {
  if (recurrence === "MONTHLY") return addMonths(dueDate, 1);
  if (recurrence === "TERM") return addMonths(dueDate, 4);
  return null;
}

const DUE = (period: string): ObligationPeriodState => ({ status: "DUE", period, proposalId: null, paymentId: null, paymentStatus: null, paidAt: null, settled: false, nextDueDate: null });

/** The state of each bill's current period (its stored due date), keyed by obligation id. */
export async function obligationPeriodStates(
  db: DbOrTx,
  userId: string,
  bills: readonly { id: string; dueDate: string; recurrence: string }[],
): Promise<Map<string, ObligationPeriodState>> {
  const out = new Map<string, ObligationPeriodState>();
  for (const b of bills) out.set(b.id, DUE(b.dueDate));
  if (bills.length === 0) return out;
  const rows = await db
    .select({ obligationId: obligationSettlements.obligationId, period: obligationSettlements.period, settlement: obligationSettlements.status, proposalId: obligationSettlements.proposalId, proposalStatus: proposals.status })
    .from(obligationSettlements)
    .innerJoin(proposals, eq(proposals.id, obligationSettlements.proposalId))
    .where(and(eq(obligationSettlements.userId, userId), inArray(obligationSettlements.obligationId, bills.map((b) => b.id))));
  const byBill = new Map(bills.map((b) => [b.id, b]));
  const held = rows.filter((r) => byBill.get(r.obligationId)?.dueDate === r.period);
  if (held.length === 0) return out;
  const pays = await db
    .select({ id: payments.id, proposalId: payments.proposalId, status: payments.status, rail: payments.rail, createdAt: payments.createdAt, updatedAt: payments.updatedAt })
    .from(payments)
    .where(and(eq(payments.userId, userId), inArray(payments.proposalId, held.map((r) => r.proposalId))))
    .orderBy(desc(payments.createdAt));
  for (const r of held) {
    const bill = byBill.get(r.obligationId)!;
    // The latest live payment of the order (a failed one released the period already, so it is not here).
    const p = pays.find((x) => x.proposalId === r.proposalId && x.status !== "FAILED" && x.status !== "CANCELED") ?? null;
    let status: ObligationPeriodStatus;
    if (p?.status === "SENT") status = "PAID";
    else if (p || r.settlement === "PAID" || r.proposalStatus === "APPROVED" || r.proposalStatus === "EXECUTED") status = "IN_FLIGHT";
    else status = "AWAITING_APPROVAL";
    const settled = status === "PAID" || (status === "IN_FLIGHT" && p?.rail === "BANK_TRANSFER");
    out.set(bill.id, {
      status,
      period: r.period,
      proposalId: r.proposalId,
      paymentId: p?.id ?? null,
      paymentStatus: p?.status ?? null,
      paidAt: status === "PAID" && p ? p.updatedAt.toISOString() : null,
      settled,
      nextDueDate: settled ? nextPeriod(bill.dueDate, bill.recurrence) : null,
    });
  }
  return out;
}
