/*
 * Clock service (spec §15): now = real now, or real now + demo_state.clockOffsetMs when demo_state.clockMode is DEMO.
 * Every expiry, cooling period, due date and job uses it — api modules never call Date.now() directly.
 * REAL is the default (a fresh database, a deployment that loads the demo data); `bun run seed`, the Stage reset and
 * the tests run the story clock (DEMO). The offset is kept while REAL, so switching back resumes the story time.
 *
 * `clock.now()` is synchronous (coordination contract), so the offset is cached in memory and refreshed
 * from demo_state by `clock.load()` (server start, scheduler tick, demo routes after a change).
 */
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { demoState } from "../../db/schema.ts";

export type ClockMode = "REAL" | "DEMO";

/** The stored demo offset (applies only in DEMO mode). */
let offsetMs = 0;
let mode: ClockMode = "REAL";
/** Tests can freeze real time; null = use the system clock. */
let frozenRealMs: number | null = null;

function realNowMs(): number {
  // The single sanctioned call site of the system clock.
  return frozenRealMs ?? Date.now();
}

export const clock = {
  now(): Date {
    return new Date(clock.nowMs());
  },
  nowMs(): number {
    return realNowMs() + clock.offsetMs();
  },
  /**
   * Wall time, never the demo clock: for credentials only (session and refresh token lifetimes), so moving or
   * switching the demo clock neither signs people out nor keeps an expired token alive.
   */
  realNowMs(): number {
    return realNowMs();
  },
  /** The offset in effect: 0 in REAL mode. */
  offsetMs(): number {
    return mode === "DEMO" ? offsetMs : 0;
  },
  /** The stored demo offset, in effect or not. */
  storedOffsetMs(): number {
    return offsetMs;
  },
  mode(): ClockMode {
    return mode;
  },
  /** Refresh the cached offset and mode from demo_state (creates the singleton row if missing). */
  async load(): Promise<number> {
    const db = getDb();
    const rows = await db.select().from(demoState).where(eq(demoState.id, 1));
    if (rows.length === 0) {
      await db.insert(demoState).values({ id: 1 }).onConflictDoNothing();
      offsetMs = 0;
      mode = "REAL";
    } else {
      offsetMs = rows[0]!.clockOffsetMs;
      mode = rows[0]!.clockMode;
    }
    return clock.offsetMs();
  },
  /** Persist the mode (Stage switch, seed). */
  async setMode(next: ClockMode): Promise<void> {
    await getDb()
      .insert(demoState)
      .values({ id: 1, clockMode: next })
      .onConflictDoUpdate({ target: demoState.id, set: { clockMode: next } });
    mode = next;
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
  /** Move the demo clock forward. In REAL mode this switches to DEMO starting from real now (not the stored story time). */
  async advanceHours(hours: number): Promise<Date> {
    await clock.load();
    const from = mode === "DEMO" ? offsetMs : 0;
    await clock.setOffset(from + Math.round(hours * 3_600_000));
    if (mode !== "DEMO") await clock.setMode("DEMO");
    return clock.now();
  },
  /** Tests only: pin the "real" time (offset still applies). */
  freezeForTests(at: Date | null): void {
    frozenRealMs = at ? at.getTime() : null;
  },
  /** Tests only: set the in-memory offset (and DEMO mode, so it applies) without touching the DB. */
  setOffsetInMemoryForTests(ms: number): void {
    offsetMs = ms;
    mode = "DEMO";
  },
  /** Tests only: set the in-memory mode without touching the DB. */
  setModeInMemoryForTests(next: ClockMode): void {
    mode = next;
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
