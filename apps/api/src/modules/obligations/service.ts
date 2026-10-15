/*
 * Bills and schedules the user sets up themselves (added 2026-10-15): rent, a utility bill, wages or monthly family
 * support to one of their recipients. The scheduler proposes each one when it falls due (scheduler/index.ts), so a
 * bill made here goes through the same rules, cooling period and passkey as every other order.
 */
import { budgetCategoryFor, type CreateObligationRequest, type PayObligationRequest } from "@kassa/shared";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { obligations, obligationSettlements, payees } from "../../db/schema.ts";
import { ownedNotFound } from "../../http/audit.ts";
import { conflict, HttpProblem } from "../../http/problem.ts";
import { clock, isoDate } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { readDetails } from "../payees/crypto.ts";
import { proposeOrder } from "../rules/index.ts";

export async function createObligation(userId: string, req: CreateObligationRequest) {
  const db = getDb();
  const p = (await db.select().from(payees).where(and(eq(payees.id, req.payeeId), eq(payees.userId, userId), isNull(payees.archivedAt))))[0];
  if (!p) throw await ownedNotFound(userId, "payee", req.payeeId, async () => (await db.select({ id: payees.id }).from(payees).where(eq(payees.id, req.payeeId))).length > 0);
  if (p.kind === "MERCHANT" || p.kind === "SUPPLIER") {
    throw new HttpProblem(422, "BILL_NOT_FOR_SHOPS", "Shops are paid at the till, not on a schedule");
  }
  if (req.currency !== p.currency) throw new HttpProblem(422, "CURRENCY_MISMATCH", `${p.name} is paid in ${p.currency}`, { reasonCodes: ["CURRENCY_MISMATCH"] });
  if (req.dueDate < isoDate(clock.now())) throw new HttpProblem(422, "DUE_DATE_PAST", "The first due date is in the past", { details: { field: "dueDate" } });
  // X1: the category is the server's (from the recipient), never the caller's.
  const category = budgetCategoryFor(p.kind, readDetails(p));
  return db.transaction(async (tx) => {
    const [o] = await tx
      .insert(obligations)
      .values({ userId, payeeId: p.id, amountMinor: req.amountMinor, currency: req.currency, dueDate: req.dueDate, recurrence: req.recurrence, reference: req.reference ?? null, category })
      .returning();
    await ledger.append("OBLIGATION_CREATED", { userId, obligationId: o!.id, payeeId: p.id, category, amountMinor: req.amountMinor, currency: req.currency, dueDate: req.dueDate, recurrence: req.recurrence, source: "user" }, tx);
    return o!;
  });
}

/** Remove a bill. Refused while an order for it is waiting (approve or reject that first). */
export async function deleteObligation(userId: string, obligationId: string) {
  const db = getDb();
  const o = (await db.select().from(obligations).where(and(eq(obligations.id, obligationId), eq(obligations.userId, userId))))[0];
  if (!o) throw await ownedNotFound(userId, "obligation", obligationId, async () => (await db.select({ id: obligations.id }).from(obligations).where(eq(obligations.id, obligationId))).length > 0);
  const pending = await db
    .select({ proposalId: obligationSettlements.proposalId })
    .from(obligationSettlements)
    .where(and(eq(obligationSettlements.obligationId, o.id), eq(obligationSettlements.status, "PENDING")));
  if (pending.length > 0) throw conflict("BILL_HAS_PENDING_ORDER", "This bill has an order waiting; approve or reject it first", { details: { proposalId: pending[0]!.proposalId } });
  await db.transaction(async (tx) => {
    await tx.delete(obligations).where(eq(obligations.id, o.id));
    await ledger.append("OBLIGATION_DELETED", { userId, obligationId: o.id, payeeId: o.payeeId }, tx);
  });
}

/**
 * Pay a bill now (e.g. a tuition invoice from the school's portal) instead of waiting for the scheduler. The order
 * claims the bill's settlement for its period exactly like the scheduler's would, so the bill is never paid twice.
 */
export async function payObligation(userId: string, obligationId: string, req: PayObligationRequest) {
  const db = getDb();
  const o = (await db.select().from(obligations).where(and(eq(obligations.id, obligationId), eq(obligations.userId, userId))))[0];
  if (!o) throw await ownedNotFound(userId, "obligation", obligationId, async () => (await db.select({ id: obligations.id }).from(obligations).where(eq(obligations.id, obligationId))).length > 0);
  const r = await proposeOrder({
    userId,
    createdBy: "USER",
    payeeId: o.payeeId,
    amountMinor: o.amountMinor,
    currency: o.currency,
    purpose: (o.reference ? `${o.category} ${o.reference}` : `${o.category} due ${o.dueDate}`).slice(0, 140),
    category: o.category,
    obligationId: o.id,
    dueDate: o.dueDate,
    ...(req.fundingSourceId ? { fundingSourceId: req.fundingSourceId } : {}),
  });
  return {
    proposalId: r.proposalId,
    decision: r.decision,
    reasonCodes: r.reasonCodes,
    summary: r.summary,
    ...(r.paymentStatus !== undefined ? { paymentStatus: r.paymentStatus } : {}),
    ...(r.deliveredInMs !== undefined ? { deliveredInMs: r.deliveredInMs } : {}),
  };
}
