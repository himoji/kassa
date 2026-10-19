/*
 * (security review 2026-10-18) A deployed mock world (locked: NODE_ENV=production, JUDGE_MODE or VERCEL) answers its
 * control routes only to the Kassa API's signed requests or the demo admin token. The API's mock-world client signs
 * every request (rails/http.ts), so its own calls keep working; an anonymous caller cannot credit a profile.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../../../mock-world/src/app.ts";
import { FIXTURE_RATES } from "../../../mock-world/src/bank/rates.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { env } from "../../src/env.ts";
import { mockWorld, mockWorldSigned, setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";

let mw: MockWorld;
const HERO_PROFILE = 16_000_001;

beforeAll(async () => {
  mw = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "production", LOG_LEVEL: "silent", MOCK_HMAC_SECRET: env().MOCK_HMAC_SECRET, DEMO_ENABLED: "true", DEMO_ADMIN_TOKEN: "t".repeat(40) }),
    clock: { now: async () => new Date() },
    rates: { getRates: async () => FIXTURE_RATES },
    webhooks: { send: (kind, body) => ({ id: "x", kind, url: "", body, createdAt: "", attempts: 0, status: "delivered", lastStatusCode: 200, lastError: null, deliveredAt: null }) },
    logger: false,
    startTicker: false,
  });
  // Like the default transport: the path goes under /mock, the API's headers are sent as they are.
  setMockWorldTransportForTests(async (method, path, body, headers) => {
    const res = await mw.app.inject({ method: method as "GET", url: `/mock${path}`, ...(headers ? { headers } : {}), ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  });
});

afterAll(async () => {
  setMockWorldTransportForTests(null);
  await mw.app.close();
});

describe("locked mock world, called by the API", () => {
  it("is locked", () => {
    expect(mw.app).toBeDefined();
    expect(loadConfig({ NODE_ENV: "production", MOCK_HMAC_SECRET: env().MOCK_HMAC_SECRET }).locked).toBe(true);
  });

  it("the API's signed calls work (wallet, money in, balances, reset)", async () => {
    await mockWorld("POST", "/bank/wallets", { profileId: 31_000_001, aliases: [] });
    await mockWorld("POST", "/remittance/incoming", { profileId: 31_000_001, amountMinor: 5_000, currency: "KZT" });
    const balances = await mockWorld<{ currency: string; amount: { value: number } }[]>("GET", "/v4/profiles/31000001/balances?types=STANDARD");
    expect(balances.find((b) => b.currency === "KZT")).toBeTruthy();
    await mockWorld("POST", "/reset", {});
    // The supplier PO route keeps its own webhook-style signature check; the extra request header does not disturb it.
    await expect(mockWorldSigned("POST", "/supplier/purchase-orders", { bad: true })).rejects.toThrow(/400/);
  });

  it("an anonymous caller cannot credit a profile or read its balances", async () => {
    const credit = await mw.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { profileId: HERO_PROFILE, amountMinor: 5_000, currency: "KZT" } });
    expect(credit.statusCode).toBe(401);
    const read = await mw.app.inject({ method: "GET", url: `/mock/v4/profiles/${HERO_PROFILE}/balances` });
    expect(read.statusCode).toBe(401);
  });
});
