import { randomUUID } from "node:crypto";

import { PairCompleteResponse, PairStartResponse } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { devices, transactions } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { devLoginAllowed, judgeModeActive } from "../../src/modules/auth/dev.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

/*
 * Dev sign-in (auth/dev.ts) and KassaLite pairing (auth/pair.ts): guards, the server-held dev passkey, single-use
 * pairing codes, and the lite scope that never gets passkey-gated rights.
 */

const t = useTestDb();
const app = useTestApp();

beforeAll(async () => {
  await ensureIntelTables(t.db());
});

afterEach(() => {
  resetEnvCache();
  clock.setOffsetInMemoryForTests(0);
});

const devEnv = () => setEnvForTests({ DEMO_ENABLED: "true", DEV_LOGIN: "true", RP_ID: "localhost" });

async function devLogin() {
  const res = await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native" } });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().tokens.accessToken as string}` };
}

/** Full pairing flow from a session `h`: 428 → assertion (signed by `sign`) → code. */
async function startPairing(h: Record<string, string>, sign: (challenge: string) => Promise<unknown>) {
  const first = await app().inject({ method: "POST", url: "/api/auth/pair/start", headers: h, payload: {} });
  expect(first.statusCode, first.body).toBe(428);
  const { challengeId, webauthnOptions } = first.json().details as { challengeId: string; webauthnOptions: { challenge: string } };
  const res = await app().inject({ method: "POST", url: "/api/auth/pair/start", headers: h, payload: { challengeId, assertion: await sign(webauthnOptions.challenge) } });
  expect(res.statusCode, res.body).toBe(200);
  return PairStartResponse.parse(res.json());
}

describe("judge build (JUDGE_MODE)", () => {
  it("turns dev sign-in on with DEMO_ENABLED, whatever the RP_ID", async () => {
    setEnvForTests({ DEMO_ENABLED: "true", JUDGE_MODE: "true", RP_ID: "kassa-judge.vercel.app" });
    expect(judgeModeActive()).toBe(true);
    expect((await app().inject({ method: "GET", url: "/api/auth/demo" })).json()).toMatchObject({ devLogin: true, judgeMode: true });
  });

  it("stays off without DEMO_ENABLED", () => {
    setEnvForTests({ DEMO_ENABLED: "false", JUDGE_MODE: "true", RP_ID: "kassa-judge.vercel.app" });
    expect(judgeModeActive()).toBe(false);
    expect(devLoginAllowed()).toBe(false);
  });
});

describe("dev sign-in", () => {
  it("is off unless DEMO_ENABLED + DEV_LOGIN + a local / tunnel RP_ID", async () => {
    expect((await app().inject({ method: "GET", url: "/api/auth/demo" })).json().devLogin).toBe(false);
    expect((await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "web" } })).statusCode).toBe(404);
    setEnvForTests({ DEMO_ENABLED: "true", DEV_LOGIN: "true", RP_ID: "kassa.example.com" });
    expect((await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "web" } })).statusCode).toBe(404);
    setEnvForTests({ DEMO_ENABLED: "true", DEV_LOGIN: "true", RP_ID: "kassa.example.com", PHONE_HOST: "kassa.example.com" });
    expect((await app().inject({ method: "GET", url: "/api/auth/demo" })).json().devLogin).toBe(true);
    setEnvForTests({ DEMO_ENABLED: "true", DEV_LOGIN: "true", RP_ID: "blue-sky-1.trycloudflare.com" });
    expect((await app().inject({ method: "GET", url: "/api/auth/demo" })).json().devLogin).toBe(true);
  });

  it("signs in as the Dev user and signs 428 challenges with the server-held passkey (real WebAuthn verification)", async () => {
    devEnv();
    const h = await devLogin();
    const again = await devLogin();
    expect(again).not.toEqual(h);
    const pair = await startPairing(h, async (challenge) => (await app().inject({ method: "POST", url: "/api/auth/dev/assert", headers: h, payload: { challenge } })).json().assertion);
    expect(pair.code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("dev mode (`fresh`) starts a brand-new, not onboarded user every time; demo mode (`demoClaim`) needs the seed", async () => {
    devEnv();
    const login = async (payload: Record<string, unknown>) => {
      const res = await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native", ...payload } });
      return { status: res.statusCode, body: res.json() };
    };
    const a = await login({ fresh: true });
    const b = await login({ fresh: true });
    expect(a.status).toBe(200);
    expect(a.body.user.id).not.toBe(b.body.user.id);
    expect(a.body.onboarded).toBe(false);
    const reused = await login({});
    expect((await login({})).body.user.id).toBe(reused.body.user.id);
    expect(reused.body.user.id).not.toBe(a.body.user.id);
    expect((await login({ demoClaim: true })).status).toBe(409);
  });

  it("/auth/dev/assert refuses a passkey user's session (no dev claim), and is off while dev sign-in is off", async () => {
    const { userId } = await createUserWithPasskey();
    const off = await app().inject({ method: "POST", url: "/api/auth/dev/assert", headers: await bearer(userId), payload: { challenge: "a".repeat(43) } });
    expect(off.statusCode).toBe(404);
    devEnv();
    const h = await bearer(userId);
    const res = await app().inject({ method: "POST", url: "/api/auth/dev/assert", headers: h, payload: { challenge: "a".repeat(43) } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("NOT_DEV_SESSION");
    // The 428 gate still wants the account's own passkey: a token alone cannot approve.
    const first = await app().inject({ method: "POST", url: "/api/auth/pair/start", headers: h, payload: {} });
    expect(first.statusCode).toBe(428);
  });

  it("/auth/dev/assert keeps working for a dev session after a token refresh (the claim is kept)", async () => {
    devEnv();
    const login = await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native" } });
    const refresh = await app().inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: login.json().tokens.refreshToken } });
    expect(refresh.statusCode, refresh.body).toBe(200);
    const h = { authorization: `Bearer ${refresh.json().accessToken as string}` };
    const sign = async (challenge: string) => (await app().inject({ method: "POST", url: "/api/auth/dev/assert", headers: h, payload: { challenge } })).json().assertion;
    expect((await startPairing(h, sign)).code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("/auth/dev/assert refuses a KassaLite session", async () => {
    devEnv();
    const { userId, auth } = await createUserWithPasskey();
    const pair = await startPairing(await bearer(userId), async (challenge) => auth.assert(challenge));
    const lite = PairCompleteResponse.parse((await app().inject({ method: "POST", url: "/api/auth/pair/complete", payload: { code: pair.code } })).json());
    const res = await app().inject({ method: "POST", url: "/api/auth/dev/assert", headers: { authorization: `Bearer ${lite.tokens!.accessToken}` }, payload: { challenge: "a".repeat(43) } });
    expect(res.statusCode).toBe(403);
  });
});

describe("KassaLite pairing", () => {
  it("a passkey-backed code pairs once: lite session + Shortcut token; expired and reused codes fail", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const h = await bearer(userId);
    const pair = await startPairing(h, async (challenge) => auth.assert(challenge));
    expect(pair.pairUrl).toContain(`code=${pair.code}`);

    const done = await app().inject({ method: "POST", url: "/api/auth/pair/complete", payload: { code: pair.code.toLowerCase().replace(/(.{4})/, "$1-") } });
    expect(done.statusCode, done.body).toBe(200);
    const body = PairCompleteResponse.parse(done.json());
    expect(body.user.id).toBe(userId);
    expect(body.shortcutToken).toMatch(/^ksc_/);
    expect((await getDb().select().from(devices).where(eq(devices.id, body.deviceId)))[0]).toMatchObject({ userId, kind: "IOS_SHORTCUT" });

    const reuse = await app().inject({ method: "POST", url: "/api/auth/pair/complete", payload: { code: pair.code } });
    expect(reuse.statusCode).toBe(401);

    const late = await startPairing(h, async (challenge) => auth.assert(challenge));
    clock.setOffsetInMemoryForTests(3 * 60_000);
    expect((await app().inject({ method: "POST", url: "/api/auth/pair/complete", payload: { code: late.code } })).statusCode).toBe(401);
  });

  it("a lite session reads activity but every passkey-gated route answers 428 with a link to the web app, also after refresh", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const pair = await startPairing(await bearer(userId), async (challenge) => auth.assert(challenge));
    const lite = PairCompleteResponse.parse((await app().inject({ method: "POST", url: "/api/auth/pair/complete", payload: { code: pair.code } })).json());
    const refreshed = await app().inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: lite.tokens!.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    for (const token of [lite.tokens!.accessToken, refreshed.json().accessToken as string]) {
      const h = { authorization: `Bearer ${token}` };
      expect((await app().inject({ method: "GET", url: "/api/capture/recent", headers: h })).statusCode).toBe(200);
      for (const url of [`/api/orders/${randomUUID()}/approve`, "/api/auth/pair/start", "/api/devices/shortcut", "/api/privacy/erase", `/api/payees/${randomUUID()}/verify-callback`, `/api/funding-sources/${randomUUID()}/confirm`]) {
        const res = await app().inject({ method: "POST", url, headers: h, payload: {} });
        expect(res.statusCode, url).toBe(428);
        expect(res.json().details.approveInWebApp, url).toMatch(/\?from=lite$/);
      }
      // The approval link opens that very order in the web app.
      const id = randomUUID();
      const approve = await app().inject({ method: "POST", url: `/api/orders/${id}/approve`, headers: h, payload: {} });
      expect(approve.json().details.approveInWebApp).toMatch(new RegExp(`/order/${id}\\?from=lite$`));
      // Every other passkey step opens its own page, not the start page (2026-10-16: "linking opens a blank page").
      const pages: [string, string, string][] = [
        ["POST", `/api/funding-sources/${randomUUID()}/confirm`, "/linked-accounts"],
        ["PATCH", "/api/settings", "/settings"],
        ["PUT", "/api/budgets", "/settings"],
        ["POST", "/api/privacy/erase", "/data"],
        ["POST", "/api/devices/shortcut", "/shortcut"],
      ];
      for (const [method, url, page] of pages) {
        const res = await app().inject({ method: method as "POST", url, headers: h, payload: {} });
        expect(new URL(res.json().details.approveInWebApp as string).pathname, url).toBe(page);
      }
    }
  });
});

describe("GET /capture/recent", () => {
  it("returns only the caller's captures, newest first, filtered by since", async () => {
    const a = await createUserWithPasskey();
    const b = await createUserWithPasskey();
    const db = getDb();
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    await db.insert(transactions).values([
      { userId: a.userId, source: "SHORTCUT", occurredAt: at(10), createdAt: at(10), merchantRaw: "Old Cafe", merchantNorm: "old cafe", amountMinor: 100, currency: "HUF", category: "food", status: "PENDING" },
      { userId: a.userId, source: "SHORTCUT", occurredAt: at(1), createdAt: at(1), merchantRaw: "New Cafe", merchantNorm: "new cafe", amountMinor: 200, currency: "HUF", category: "food", status: "PENDING" },
      { userId: b.userId, source: "SHORTCUT", occurredAt: at(1), createdAt: at(1), merchantRaw: "Bob Bakery", merchantNorm: "bob bakery", amountMinor: 300, currency: "HUF", category: "food", status: "PENDING" },
    ]);
    const res = await app().inject({ method: "GET", url: "/api/capture/recent", headers: await bearer(a.userId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().captures.map((c: { merchant: string }) => c.merchant)).toEqual(["New Cafe", "Old Cafe"]);
    expect(res.body).not.toContain("Bob Bakery");
    const since = encodeURIComponent(at(5).toISOString());
    const recent = await app().inject({ method: "GET", url: `/api/capture/recent?since=${since}`, headers: await bearer(a.userId) });
    expect(recent.json().captures.map((c: { merchant: string }) => c.merchant)).toEqual(["New Cafe"]);
  });
});
