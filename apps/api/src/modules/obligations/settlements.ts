/*
 * Obligation settlement records (B4): at most one live proposal per (obligation, period), enforced by the
 * primary key of `obligation_settlements` so concurrent proposers (scheduler tick + agent turn) cannot both
 * win. Rules claims the period when it creates a non-refused proposal; the period is released when the
 * order is rejected or its payment fails, so the bill can be proposed again. Payments (status callbacks)
 * and rules both use this module; it imports neither.
 */
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { obligationSettlements } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";

export type SettlementStatus = "PENDING" | "PAID";

export async function settlementFor(db: DbOrTx, obligationId: string, period: string): Promise<{ proposalId: string; status: SettlementStatus } | null> {
  const r = (
    await db
      .select({ proposalId: obligationSettlements.proposalId, status: obligationSettlements.status })
      .from(obligationSettlements)
      .where(and(eq(obligationSettlements.obligationId, obligationId), eq(obligationSettlements.period, period)))
  )[0];
  return r ?? null;
}

/** Claim the period for `proposalId` (status PENDING). false = another proposal already holds it. */
export async function claimSettlement(db: DbOrTx, s: { userId: string; obligationId: string; period: string; proposalId: string }): Promise<boolean> {
  const now = clock.now();
  const rows = await db
    .insert(obligationSettlements)
    .values({ ...s, status: "PENDING", createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ proposalId: obligationSettlements.proposalId });
  return rows.length === 1;
}

/** The proposal's payment was created (executed): the period counts as paid. */
export async function markSettlementPaid(db: DbOrTx, proposalId: string): Promise<void> {
  await db.update(obligationSettlements).set({ status: "PAID", updatedAt: clock.now() }).where(eq(obligationSettlements.proposalId, proposalId));
}

/** Rejected order or failed / canceled payment: free the period for a new proposal. */
export async function releaseSettlement(db: DbOrTx, proposalId: string): Promise<void> {
  await db.delete(obligationSettlements).where(eq(obligationSettlements.proposalId, proposalId));
}
