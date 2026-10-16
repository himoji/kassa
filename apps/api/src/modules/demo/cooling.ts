/*
 * The demo switch for the 24 h waits (I7 recipient cooling, the loosening delay of settings, mandates and unfreeze).
 * On by default. A user can turn it off for themselves only, only while DEMO_ENABLED, and only with their passkey
 * (POST /demo/cooling); turning it back on needs nothing (it tightens). Both are ledger entries. Outside demo mode
 * the route does not exist and a stored row is ignored, so production always waits. While off, the app shows a
 * banner on every screen (MeResponse.demo.coolingOff). The agent has no tool for it.
 */
import { eq } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { demoCoolingOff } from "../../db/schema.ts";
import { env } from "../../env.ts";

/** True unless this user turned the waits off in a demo deployment. A read error counts as on. */
export async function coolingOn(userId: string, db: DbOrTx = getDb()): Promise<boolean> {
  if (!env().DEMO_ENABLED) return true;
  const rows = await db
    .select({ userId: demoCoolingOff.userId })
    .from(demoCoolingOff)
    .where(eq(demoCoolingOff.userId, userId))
    .catch(() => null);
  return !rows || rows.length === 0;
}

/** The wait to apply: `ms`, or 0 when this user turned the waits off (see the header comment). */
export async function waitMs(userId: string, ms: number, db: DbOrTx = getDb()): Promise<number> {
  return (await coolingOn(userId, db)) ? ms : 0;
}
