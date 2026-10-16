/*
 * R14: logout cleared the web cookie but did not revoke the JWT inside it, so a copied cookie stayed valid until its
 * 7-day expiry. POST /auth/logout now records the cookie's jti in revoked_tokens and the session check refuses it,
 * on this server and on a restarted one (OWASP ASVS 3.3.1, session termination).
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { revokedTokens } from "../../src/db/schema.ts";
import { COOKIE_TTL_S, mintSessionCookieForTests, SESSION_COOKIE } from "../../src/modules/auth/session.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { buildServer } from "../../src/server.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();
let restarted: FastifyInstance | null = null;

afterAll(async () => {
  await restarted?.close();
});

const me = (a: FastifyInstance, cookie: string) => a.inject({ method: "GET", url: "/api/me", cookies: { [SESSION_COOKIE]: cookie } });
const logout = (cookie?: string) => app().inject({ method: "POST", url: "/api/auth/logout", payload: {}, ...(cookie ? { cookies: { [SESSION_COOKIE]: cookie } } : {}) });

describe("R14 logout revokes the web cookie", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("a logged-out cookie is refused, here and after a restart; another session of the user is not", async () => {
    const { userId } = await createUserWithPasskey();
    const cookie = await mintSessionCookieForTests(userId);
    const otherDevice = await mintSessionCookieForTests(userId);
    expect((await me(app(), cookie)).statusCode).toBe(200);

    const out = await logout(cookie);
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe("");

    const replay = await me(app(), cookie);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("UNAUTHENTICATED");
    restarted = await buildServer({ logger: false });
    await restarted.ready();
    expect((await me(restarted, cookie)).statusCode).toBe(401);
    expect((await me(app(), otherDevice)).statusCode).toBe(200);
  });

  it("the revocation lives until the cookie's own expiry (wall time)", async () => {
    const { userId } = await createUserWithPasskey();
    const before = Math.floor(clock.realNowMs() / 1000);
    await logout(await mintSessionCookieForTests(userId));
    const [row] = await getDb().select().from(revokedTokens);
    expect(row?.kind).toBe("session");
    const expS = row!.expiresAt.getTime() / 1000;
    expect(expS).toBeGreaterThanOrEqual(before + COOKIE_TTL_S);
    expect(expS).toBeLessThanOrEqual(before + COOKIE_TTL_S + 5);
  });

  it("logout without a cookie, or with a forged one, still answers 204 and records nothing", async () => {
    expect((await logout()).statusCode).toBe(204);
    const { userId } = await createUserWithPasskey();
    const forged = `${(await mintSessionCookieForTests(userId)).slice(0, -4)}AAAA`;
    expect((await logout(forged)).statusCode).toBe(204);
    expect(await getDb().select().from(revokedTokens)).toHaveLength(0);
  });
});
