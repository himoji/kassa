/*
 * R13: the refresh-token spent list and the rate-limit counters were process memory, so a restart (or a second API
 * instance) accepted a spent refresh token again and reset every rate limit. Both are in Postgres now
 * (auth/revocation.ts, http/rate-limit-store.ts); a "restart" here is a fresh server on the same database, with the
 * in-memory caches cleared. RFC 9700 §4.14.2 (refresh token rotation), OWASP API4:2023.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { rateLimitCounters, revokedTokens } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { clearRateLimitFallbackForTests, PgRateLimitStore, purgeRateLimitCounters } from "../../src/http/rate-limit-store.ts";
import { purgeRevokedTokens } from "../../src/modules/auth/revocation.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { clearDekCache } from "../../src/modules/privacy/keys.ts";
import { buildServer } from "../../src/server.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const started: FastifyInstance[] = [];

/** A new API process on the same database: nothing carried over in memory. */
async function restart(): Promise<FastifyInstance> {
  clearDekCache();
  clearRateLimitFallbackForTests();
  const app = await buildServer({ logger: false });
  await app.ready();
  started.push(app);
  return app;
}

afterAll(async () => {
  for (const a of started) await a.close();
  resetEnvCache();
});

async function registerNative(app: FastifyInstance) {
  const auth = new SoftAuthenticator();
  const opt = (await app.inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "Test Person" } })).json();
  const res = await app.inject({ method: "POST", url: "/api/auth/register/verify", payload: { challengeId: opt.challengeId, response: auth.register(opt.options.challenge), client: "native" } });
  expect(res.statusCode).toBe(200);
  return res.json().tokens as { accessToken: string; refreshToken: string };
}

const refresh = (app: FastifyInstance, refreshToken: string) => app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken } });

describe("R13 spent refresh tokens survive a restart", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("a rotated refresh token stays rejected on a new server", async () => {
    const a = await restart();
    const first = await registerNative(a);
    const rotated = await refresh(a, first.refreshToken);
    expect(rotated.statusCode).toBe(200);

    const b = await restart();
    expect((await refresh(b, first.refreshToken)).statusCode).toBe(401);
    // The rotated token is still good on the new server (and only once).
    const next = rotated.json() as { refreshToken: string };
    expect((await refresh(b, next.refreshToken)).statusCode).toBe(200);
    expect((await refresh(a, next.refreshToken)).statusCode).toBe(401);
  });

  it("a refresh token revoked on logout stays rejected on a new server", async () => {
    const a = await restart();
    const tokens = await registerNative(a);
    expect((await a.inject({ method: "POST", url: "/api/auth/logout", payload: { refreshToken: tokens.refreshToken } })).statusCode).toBe(204);
    const b = await restart();
    expect((await refresh(b, tokens.refreshToken)).statusCode).toBe(401);
  });

  it("two concurrent uses of one refresh token: exactly one succeeds", async () => {
    const a = await restart();
    const b = await restart();
    const tokens = await registerNative(a);
    const codes = (await Promise.all([refresh(a, tokens.refreshToken), refresh(b, tokens.refreshToken)])).map((r) => r.statusCode);
    expect(codes.sort()).toEqual([200, 401]);
  });

  it("a forged logout body records nothing; the scheduler purges rows past the token's expiry (wall time)", async () => {
    const a = await restart();
    await a.inject({ method: "POST", url: "/api/auth/logout", payload: { refreshToken: "not.a.jwt" } });
    expect(await getDb().select().from(revokedTokens)).toHaveLength(0);

    const tokens = await registerNative(a);
    await refresh(a, tokens.refreshToken);
    const [row] = await getDb().select().from(revokedTokens);
    expect(row).toMatchObject({ kind: "refresh" });
    expect(await purgeRevokedTokens(clock.realNowMs())).toBe(0);
    expect(await purgeRevokedTokens(row!.expiresAt.getTime() + 1)).toBe(1);
    expect(await getDb().select().from(revokedTokens)).toHaveLength(0);
  });
});

describe("R13 rate-limit counters are shared and survive a restart", () => {
  beforeEach(async () => {
    await t.reset();
    setEnvForTests({ RATE_LIMIT_AUTH_PER_MIN: "3" });
  });

  it("the budget spent on one server is spent on the next", async () => {
    const a = await restart();
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await a.inject({ method: "POST", url: "/api/auth/login/options" })).statusCode);
    const b = await restart();
    codes.push((await b.inject({ method: "POST", url: "/api/auth/login/options" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    // Per-route buckets: another auth route still has its own budget.
    expect((await b.inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "Test Person" } })).statusCode).toBe(200);
  });

  it("a window starts at the first hit and is purged once it ended", async () => {
    const store = new PgRateLimitStore();
    const incr = (key: string) => new Promise<{ current: number; ttl: number }>((resolve, reject) => store.incr(key, (e, r) => (e || !r ? reject(e) : resolve(r)), 60_000, 3));
    expect(await incr("203.0.113.7")).toMatchObject({ current: 1 });
    const second = await incr("203.0.113.7");
    expect(second.current).toBe(2);
    expect(second.ttl).toBeGreaterThan(0);
    expect(second.ttl).toBeLessThanOrEqual(60_000);
    expect(await purgeRateLimitCounters(clock.realNowMs())).toBe(0);
    expect(await purgeRateLimitCounters(clock.realNowMs() + 60_001)).toBe(1);
    expect(await incr("203.0.113.7")).toMatchObject({ current: 1 });
  });

  it("when the database call fails, the hit is counted in memory instead (never unlimited)", async () => {
    const a = await restart();
    await getDb().execute(sql`alter table rate_limit_counters rename to rate_limit_counters_off`);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await a.inject({ method: "POST", url: "/api/auth/login/options" })).statusCode);
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await getDb().execute(sql`alter table rate_limit_counters_off rename to rate_limit_counters`);
    }
    expect(await getDb().select().from(rateLimitCounters)).toHaveLength(0);
  });
});
