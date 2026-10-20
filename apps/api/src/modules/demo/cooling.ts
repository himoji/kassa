/*
 * The demo switch for the 24 h waits (I7 recipient cooling, the loosening delay of settings, mandates and unfreeze).
 * (2026-10-20) Off by default on a demo deployment (COOLING_DEFAULT, env.ts); each user can turn them on for
 * themselves (no passkey: it tightens) and off again with their passkey (POST /demo/cooling). Both are ledger entries.
 * Outside demo mode the route does not exist and stored rows are ignored, so a real deployment always waits.
 * The agent has no tool for it.
 */
import { eq } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { demoCoolingOff, demoCoolingOn } from "../../db/schema.ts";
import { env } from "../../env.ts";

/** Whether this user's 24 h waits apply. A read error counts as on. */
export async function coolingOn(userId: string, db: DbOrTx = getDb()): Promise<boolean> {
  const e = env();
  if (!e.DEMO_ENABLED) return true;
  try {
    const [on, off] = await Promise.all([
      db.select({ userId: demoCoolingOn.userId }).from(demoCoolingOn).where(eq(demoCoolingOn.userId, userId)),
      db.select({ userId: demoCoolingOff.userId }).from(demoCoolingOff).where(eq(demoCoolingOff.userId, userId)),
    ]);
    if (on.length > 0) return true;
    if (off.length > 0) return false;
    return e.COOLING_DEFAULT === "on";
  } catch {
    return true;
  }
}

/** The wait to apply: `ms`, or 0 when this user's waits are off (see the header comment). */
export async function waitMs(userId: string, ms: number, db: DbOrTx = getDb()): Promise<number> {
  return (await coolingOn(userId, db)) ? ms : 0;
}
