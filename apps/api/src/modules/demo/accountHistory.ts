/*
 * The ACCOUNT_HISTORY_IMPORTED ledger entry (a seeded demo account's simulated history of the months before; written by
 * demo/judgeCopy.ts seedAccountHistory, read by the credit record). A leaf: database and schema only.
 */
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { ledgerEntries } from "../../db/schema.ts";

/** The payload of the ACCOUNT_HISTORY_IMPORTED ledger entry. */
export type AccountHistory = {
  userId: string;
  simulated: true;
  source: "seed";
  openedOn: string;
  bills: { obligationId: string; category: string; period: string; paidOn: string; amountMinor: number; currency: string }[];
  incomes: { on: string; amountMinor: number; currency: string }[];
};

export const ACCOUNT_HISTORY_TYPE = "ACCOUNT_HISTORY_IMPORTED";

/** The user's imported (seeded) history, or null. One entry per user; the latest wins if there were more. */
export async function accountHistoryOf(userId: string): Promise<AccountHistory | null> {
  const rows = await getDb()
    .select({ payload: ledgerEntries.payload })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.type, ACCOUNT_HISTORY_TYPE), sql`${ledgerEntries.payload}->>'userId' = ${userId}`))
    .orderBy(sql`${ledgerEntries.seq} desc`)
    .limit(1);
  return (rows[0]?.payload as AccountHistory | undefined) ?? null;
}

