/*
 * (added 2026-10-16) The user's identity check (KYC) standing, read from kyc_checks: the latest check's outcome, or
 * NONE. Database reads only (no rails, no fx), so rules, payments, the wallet and the privacy export can each read it
 * themselves without reaching the identity checker.
 */
import { KycCheckDto, type KycStatus } from "@kassa/shared";
import { desc, eq } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { kycChecks } from "../../db/schema.ts";
import { openPii } from "../privacy/keys.ts";

export type KycCheckRow = typeof kycChecks.$inferSelect;

export async function latestKycCheck(db: DbOrTx, userId: string): Promise<KycCheckRow | null> {
  const rows = await db.select().from(kycChecks).where(eq(kycChecks.userId, userId)).orderBy(desc(kycChecks.createdAt), desc(kycChecks.checkedAt)).limit(1);
  return rows[0] ?? null;
}

/** The latest check decides: a later REVIEW or REJECTED replaces an earlier VERIFIED. */
export async function kycStatusOf(db: DbOrTx, userId: string): Promise<KycStatus> {
  return (await latestKycCheck(db, userId))?.outcome ?? "NONE";
}

/** The owner's view of a check: the sealed last 4 characters opened (null once the data key is shredded). */
export async function toKycDto(row: KycCheckRow, db: DbOrTx = getDb()): Promise<KycCheckDto> {
  const opened = row.pii ? await openPii(row.userId, row.pii, db) : null;
  const last4 = typeof opened?.documentLast4 === "string" ? opened.documentLast4 : null;
  return KycCheckDto.parse({
    id: row.id,
    outcome: row.outcome,
    reasonCodes: row.reasonCodes,
    documentType: row.documentType,
    documentCountry: row.documentCountry,
    documentLast4: last4,
    createdAt: row.createdAt.toISOString(),
    checkedAt: row.checkedAt.toISOString(),
    simulated: row.simulated,
  });
}
