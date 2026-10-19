/*
 * (R13) @fastify/rate-limit store in Postgres (rate_limit_counters), so every API instance counts against the same
 * budget and a restart does not reset it. Same semantics as the plugin's in-memory LocalStore: a window starts at a
 * key's first hit and lasts `timeWindow`; a hit after it starts a new window. One atomic upsert per request.
 * Buckets: the global store is one namespace for every route without its own limit (as LocalStore shares one LRU);
 * a route with its own limit gets a child store namespaced by method and URL.
 * If the database call fails, that hit is counted in process memory instead (the previous behaviour), so an outage
 * degrades to per-instance limits rather than to no limit or to failing every request.
 * Windows use wall time (clock.realNowMs), never the demo clock.
 */
import type { FastifyRateLimitOptions, FastifyRateLimitStore } from "@fastify/rate-limit";
import { lt, sql } from "drizzle-orm";

import { getDb } from "../db/client.ts";
import { rateLimitCounters } from "../db/schema.ts";
import { clock } from "../modules/clock/index.ts";

type Hit = { current: number; ttl: number };
type Callback = (error: Error | null, result?: Hit) => void;

/** Fallback counters (bounded like LocalStore's LRU: the oldest key is dropped first). */
const FALLBACK_MAX_KEYS = 5000;
const fallback = new Map<string, { hits: number; startMs: number }>();

function fallbackIncr(key: string, nowMs: number, timeWindow: number): Hit {
  let e = fallback.get(key);
  if (!e || e.startMs + timeWindow <= nowMs) {
    fallback.delete(key);
    e = { hits: 0, startMs: nowMs };
    if (fallback.size >= FALLBACK_MAX_KEYS) fallback.delete(fallback.keys().next().value as string);
  }
  e.hits++;
  fallback.set(key, e);
  return { current: e.hits, ttl: e.startMs + timeWindow - nowMs };
}

/** Tests: forget the in-memory fallback counters. */
export function clearRateLimitFallbackForTests(): void {
  fallback.clear();
}

async function dbIncr(key: string, nowMs: number, timeWindow: number): Promise<Hit> {
  const now = new Date(nowMs).toISOString();
  const end = new Date(nowMs + timeWindow).toISOString();
  const t = rateLimitCounters;
  const expired = sql`${t.expiresAt} <= ${now}::timestamptz`;
  const row = (
    await getDb()
      .insert(t)
      .values({ key, hits: 1, windowStart: new Date(nowMs), expiresAt: new Date(nowMs + timeWindow) })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          hits: sql`case when ${expired} then 1 else ${t.hits} + 1 end`,
          windowStart: sql`case when ${expired} then ${now}::timestamptz else ${t.windowStart} end`,
          expiresAt: sql`case when ${expired} then ${end}::timestamptz else ${t.expiresAt} end`,
        },
      })
      .returning({ hits: t.hits, expiresAt: t.expiresAt })
  )[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  return { current: row.hits, ttl: Math.max(0, row.expiresAt.getTime() - nowMs) };
}

/**
 * One hit on a counter outside the plugin (a budget a handler checks itself, http/security.ts `consumeIpBudget`):
 * the same table, window semantics and in-memory fallback as the plugin's buckets, under its own namespace.
 */
export async function incrCounter(namespace: string, key: string, timeWindow: number): Promise<Hit> {
  const k = `${namespace}|${key}`;
  const nowMs = clock.realNowMs();
  return dbIncr(k, nowMs, timeWindow).catch(() => fallbackIncr(k, nowMs, timeWindow));
}

export class PgRateLimitStore implements FastifyRateLimitStore {
  private readonly namespace: string;

  constructor(_options?: FastifyRateLimitOptions, namespace = "global") {
    this.namespace = namespace;
  }

  incr(key: string, cb: Callback, timeWindow: number, _max?: number): void {
    const k = `${this.namespace}|${key}`;
    const nowMs = clock.realNowMs();
    dbIncr(k, nowMs, timeWindow).then(
      (hit) => cb(null, hit),
      () => cb(null, fallbackIncr(k, nowMs, timeWindow)),
    );
  }

  child(routeOptions: Parameters<FastifyRateLimitStore["child"]>[0]): FastifyRateLimitStore {
    // At runtime the plugin passes the merged limit params with the route under `routeInfo`.
    const r = (routeOptions as { routeInfo?: { method?: unknown; url?: unknown } }).routeInfo ?? routeOptions;
    return new PgRateLimitStore(undefined, `${String(r.method)} ${String(r.url)}`);
  }
}

/** Scheduler job: drop counters whose window has ended. Returns the count. */
export async function purgeRateLimitCounters(nowMs: number = clock.realNowMs()): Promise<number> {
  const rows = await getDb()
    .delete(rateLimitCounters)
    .where(lt(rateLimitCounters.expiresAt, new Date(nowMs)))
    .returning({ key: rateLimitCounters.key });
  return rows.length;
}
