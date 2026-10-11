/*
 * Clock service (spec §15): now = real now + demo_state.clockOffsetMs. Every expiry, cooling period,
 * due date and job uses it — api modules never call Date.now() directly.
 *
 * `clock.now()` is synchronous (coordination contract), so the offset is cached in memory and refreshed
 * from demo_state by `clock.load()` (server start, scheduler tick, demo routes after a change).
 */
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { demoState } from "../../db/schema.ts";

let offsetMs = 0;
/** Tests can freeze real time; null = use the system clock. */
let frozenRealMs: number | null = null;

function realNowMs(): number {
  // The single sanctioned call site of the system clock.
  return frozenRealMs ?? Date.now();
}

export const clock = {
  now(): Date {
    return new Date(realNowMs() + offsetMs);
  },
  nowMs(): number {
    return realNowMs() + offsetMs;
  },
  offsetMs(): number {
    return offsetMs;
  },
  /** Refresh the cached offset from demo_state (creates the singleton row if missing). */
  async load(): Promise<number> {
    const db = getDb();
    const rows = await db.select().from(demoState).where(eq(demoState.id, 1));
    if (rows.length === 0) {
      await db.insert(demoState).values({ id: 1 }).onConflictDoNothing();
      offsetMs = 0;
    } else {
      offsetMs = rows[0]!.clockOffsetMs;
    }
    return offsetMs;
  },
  /** Persist a new offset (demo clock advance / reset). */
  async setOffset(ms: number): Promise<void> {
    if (!Number.isSafeInteger(ms)) throw new RangeError("clock offset must be an integer of ms");
    const db = getDb();
    await db
      .insert(demoState)
      .values({ id: 1, clockOffsetMs: ms })
      .onConflictDoUpdate({ target: demoState.id, set: { clockOffsetMs: ms } });
    offsetMs = ms;
  },
  async advanceHours(hours: number): Promise<Date> {
    await clock.load();
    await clock.setOffset(offsetMs + Math.round(hours * 3_600_000));
    return clock.now();
  },
  /** Tests only: pin the "real" time (offset still applies). */
  freezeForTests(at: Date | null): void {
    frozenRealMs = at ? at.getTime() : null;
  },
  /** Tests only: set the in-memory offset without touching the DB. */
  setOffsetInMemoryForTests(ms: number): void {
    offsetMs = ms;
  },
};

export type Clock = typeof clock;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** ISO 8601 calendar date (UTC) "YYYY-MM-DD". */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
