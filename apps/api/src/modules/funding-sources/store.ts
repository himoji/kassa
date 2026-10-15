/*
 * Linked accounts, read side only (no rails, no Stripe): rules uses this to check the source a user picked before it
 * signs it into an order, so the agent's import closure (agent → rules) never reaches a rail (I1).
 */
import type { FundingSourceDto } from "@kassa/shared";
import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { fundingSources } from "../../db/schema.ts";

export type FundingSourceRow = typeof fundingSources.$inferSelect;

export function labelOf(row: Pick<FundingSourceRow, "institution" | "last4">): string {
  return `${row.institution} ••${row.last4}`;
}

export function toFundingSourceDto(row: FundingSourceRow): FundingSourceDto {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    label: labelOf(row),
    institution: row.institution,
    last4: row.last4,
    country: row.country,
    currency: row.currency,
    status: row.status,
    simulated: row.simulated,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

/** The user's linked accounts (pending and active; removed ones are hidden). */
export async function listFundingSources(userId: string): Promise<FundingSourceRow[]> {
  return getDb()
    .select()
    .from(fundingSources)
    .where(and(eq(fundingSources.userId, userId), ne(fundingSources.status, "REMOVED")))
    .orderBy(fundingSources.createdAt);
}

/** An ACTIVE source of this user, or null. */
export async function activeFundingSource(userId: string, id: string): Promise<FundingSourceRow | null> {
  const row = (await getDb().select().from(fundingSources).where(and(eq(fundingSources.id, id), eq(fundingSources.userId, userId))))[0];
  return row && row.status === "ACTIVE" ? row : null;
}
