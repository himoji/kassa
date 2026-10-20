/*
 * The demo switch for the 24 h waits (demo/cooling.ts, POST /demo/cooling). Off needs the user's passkey and is
 * logged; on needs nothing; it applies to that user only; outside demo mode the route is absent and a stored row
 * is ignored, so production always waits. Fictitious recipients only.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { demoCoolingOff, ledgerEntries } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { buildServer } from "../../src/server.ts";
import { SoftAuthenticator } from "../../src/modules/auth/soft-authenticator.ts";
import { clock, HOUR_MS } from "../../src/modules/clock/index.ts";
import { coolingOn, waitMs } from "../../src/modules/demo/cooling.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const MUM = { name: "Mum in Almaty", kind: "PERSON" as const, account: "KZ86125KZT5004100100", country: "KZ", currency: "KZT" };

async function turnOff(userId: string, auth: SoftAuthenticator) {
  const headers = await bearer(userId);
  const first = await app().inject({ method: "POST", url: "/api/demo/cooling", headers, payload: { enabled: false } });
  expect(first.statusCode).toBe(428);
  const { challengeId, webauthnOptions } = first.json().details as { challengeId: string; webauthnOptions: { challenge: string } };
  return app().inject({ method: "POST", url: "/api/demo/cooling", headers, payload: { enabled: false, challengeId, assertion: auth.assert(webauthnOptions.challenge) } });
}

const coolingHours = (p: { coolingUntil: Date | null }) => (p.coolingUntil!.getTime() - clock.nowMs()) / HOUR_MS;

describe("demo switch for the 24 h waits", () => {
  beforeEach(async () => {
    await t.reset();
  });
  afterEach(() => resetEnvCache());

  it("is on by default: a new recipient cools for 24 h", async () => {
    const { userId } = await createUserWithPasskey({ counter: 1 });
    expect(await coolingOn(userId)).toBe(true);
    const me = await app().inject({ method: "GET", url: "/api/me", headers: await bearer(userId) });
    expect(me.json().demo.coolingOff).toBe(false);
    expect(coolingHours(await createPayee(userId, MUM))).toBeGreaterThan(23.9);
  });

  it("turning it off needs the passkey, is logged, shows in /me and drops the wait for that user only", async () => {
    const { userId, auth } = await createUserWithPasskey({ counter: 1 });
    const other = await createUserWithPasskey({ counter: 1 });
    const headers = await bearer(userId);

    const first = await app().inject({ method: "POST", url: "/api/demo/cooling", headers, payload: { enabled: false } });
    const { challengeId } = first.json().details as { challengeId: string };
    const forged = await app().inject({ method: "POST", url: "/api/demo/cooling", headers, payload: { enabled: false, challengeId, assertion: new SoftAuthenticator().assert("x") } });
    expect(forged.statusCode).toBe(403);
    expect(await coolingOn(userId)).toBe(true);

    const off = await turnOff(userId, auth);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ coolingOn: false });
    const logged = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEMO_COOLING_OFF"));
    expect(logged).toHaveLength(1);
    expect((await app().inject({ method: "GET", url: "/api/me", headers })).json().demo.coolingOff).toBe(true);

    const p = await createPayee(userId, MUM);
    expect(p.status).toBe("COOLING");
    expect(coolingHours(p)).toBeLessThanOrEqual(0);
    expect(await waitMs(userId, 24 * HOUR_MS)).toBe(0);
    // Someone else on the same demo deployment still waits.
    expect(coolingHours(await createPayee(other.userId, MUM))).toBeGreaterThan(23.9);
  });

  it("turning it back on needs no passkey and is logged", async () => {
    const { userId, auth } = await createUserWithPasskey({ counter: 1 });
    expect((await turnOff(userId, auth)).statusCode).toBe(200);
    const on = await app().inject({ method: "POST", url: "/api/demo/cooling", headers: await bearer(userId), payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ coolingOn: true, offAt: null });
    expect(await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEMO_COOLING_ON"))).toHaveLength(1);
    expect(coolingHours(await createPayee(userId, MUM))).toBeGreaterThan(23.9);
  });

  it("COOLING_DEFAULT=off (the deployed default): no wait until the user turns it on, then 24 h; off again needs the passkey", async () => {
    setEnvForTests({ COOLING_DEFAULT: "off" });
    const { userId, auth } = await createUserWithPasskey({ counter: 1 });
    expect(await coolingOn(userId)).toBe(false);
    expect(await waitMs(userId, HOUR_MS)).toBe(0);
    expect(coolingHours(await createPayee(userId, MUM))).toBeLessThan(0.01);

    const on = await app().inject({ method: "POST", url: "/api/demo/cooling", headers: await bearer(userId), payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ coolingOn: true, offAt: null });
    expect(await coolingOn(userId)).toBe(true);
    expect(await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEMO_COOLING_ON"))).toHaveLength(1);
    expect(coolingHours(await createPayee(userId, { name: "Landlord", kind: "PERSON" as const, account: "HU75109183242065038100000003", country: "HU", currency: "HUF" }))).toBeGreaterThan(23.9);

    const off = await turnOff(userId, auth);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ coolingOn: false });
  });

  it("outside demo mode the switch does not exist and a stored row is ignored", async () => {
    const { userId } = await createUserWithPasskey({ counter: 1 });
    await getDb().insert(demoCoolingOff).values({ userId, credentialId: "x", offAt: clock.now() });
    setEnvForTests({ DEMO_ENABLED: "false", COOLING_DEFAULT: "off" });
    const prod = await buildServer({ logger: false });
    await prod.ready();
    try {
      const res = await prod.inject({ method: "POST", url: "/api/demo/cooling", headers: await bearer(userId), payload: { enabled: false } });
      expect(res.statusCode).toBe(404);
      expect(await coolingOn(userId)).toBe(true);
      expect(coolingHours(await createPayee(userId, MUM))).toBeGreaterThan(23.9);
      expect((await prod.inject({ method: "GET", url: "/api/me", headers: await bearer(userId) })).json().demo).toBeNull();
    } finally {
      await prod.close();
    }
  });
});
