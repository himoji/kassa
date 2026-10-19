import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO_TOKEN_HEADER, MOCK_REQUEST_AUTH_HEADER, mockRequestAuth, mockWebhookHeaders } from "@kassa/shared";

import { ROUTE_ACCESS } from "../src/access.ts";
import { buildMockWorld, type MockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { Issuer } from "../src/shop/issuer.ts";
import { RecordingSink } from "../src/webhooks.ts";

/*
 * Deployed builds (security review, 2026-10-18): the mock world's control routes answer only the Kassa API (signed
 * request) or the demo admin token; pages, catalogs and capability links stay public. Local development stays open.
 */

const SECRET = "hmac-secret-for-access-tests-0123456789";
const TOKEN = "demo-admin-token-for-access-tests-0123456789";
const HERO = "c83d27e3-4e03-570f-8fea-87db32399c12";
const fakeIssuer: Issuer = {
  provider: "fake" as const,
  authorize: async () => ({ approved: true, provider: "fake", authorizationId: "auth_1", reasonCode: null, issuerStatus: 200 }),
};

const baseEnv = { API_URL: "http://api.test", MOCK_PUBLIC_URL: "http://mock.test", MOCK_HMAC_SECRET: SECRET };

async function world(env: Record<string, string>): Promise<MockWorld> {
  return buildMockWorld({
    config: loadConfig({ ...baseEnv, ...env } as NodeJS.ProcessEnv),
    clock: new ManualClock(Date.parse("2026-10-27T09:00:00Z")),
    webhooks: new RecordingSink(),
    rates: new StaticRates(),
    issuer: fakeIssuer,
    logger: false,
    startTicker: false,
  });
}

const now = () => Math.floor(Date.now() / 1000);
const signed = (method: string, url: string, body?: unknown, at = now()) => ({
  [MOCK_REQUEST_AUTH_HEADER]: mockRequestAuth(SECRET, method, url, body === undefined ? "" : JSON.stringify(body), at),
});
const REMIT = { profileId: HERO, amountMinor: 5_000_000, currency: "KZT" };

describe("locked mock world (NODE_ENV=production, DEMO_ADMIN_TOKEN set)", () => {
  let w: MockWorld;
  let app: FastifyInstance;
  beforeAll(async () => {
    w = await world({ NODE_ENV: "production", DEMO_ENABLED: "true", DEMO_ADMIN_TOKEN: TOKEN });
    app = w.app;
  });
  afterAll(async () => app.close());

  it("is locked", () => {
    expect(loadConfig({ ...baseEnv, NODE_ENV: "production" } as NodeJS.ProcessEnv).locked).toBe(true);
  });

  it("refuses anonymous control calls: money in, wallets, balances, reset, outbox, the QR attack switch", async () => {
    const before = await w.bank.listBalances(await w.bank.resolveProfile(HERO));
    const calls: [string, string, unknown?][] = [
      ["POST", "/mock/remittance/incoming", REMIT],
      ["POST", "/mock/bank/top-ups", { profileId: HERO, currency: "KZT", amountMinor: 100, reference: "attacker-1" }],
      ["POST", "/mock/bank/wallets", { profileId: 31_000_000, aliases: [HERO] }],
      ["GET", "/mock/v4/profiles/16000001/balances"],
      ["GET", "/mock/bank/transfers"],
      ["POST", "/mock/reset", {}],
      ["GET", "/mock/outbox"],
      ["POST", "/mock/qr/attack/swap", { enabled: true }],
      ["POST", "/mock/pos/emit", { sku: "DOUGH-BALL", level: 1 }],
      ["POST", "/mock/kyc/checks", { accountName: "X" }],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await w.bank.listBalances(await w.bank.resolveProfile(HERO))).map((b) => b.amount)).toEqual(before.map((b) => b.amount));
    expect(w.qr.swapAll).toBe(false);
  });

  it("accepts the Kassa API's signed request, bound to method, path, body and time", async () => {
    const ok = await app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: REMIT, headers: signed("POST", "/mock/remittance/incoming", REMIT) });
    expect(ok.statusCode, ok.body).toBe(202);
    const bal = await app.inject({ method: "GET", url: "/mock/v4/profiles/16000001/balances?types=STANDARD", headers: signed("GET", "/mock/v4/profiles/16000001/balances?types=STANDARD") });
    expect(bal.statusCode).toBe(200);

    const tampered = await app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { ...REMIT, amountMinor: 999_999_999 }, headers: signed("POST", "/mock/remittance/incoming", REMIT) });
    expect(tampered.statusCode).toBe(401);
    const otherPath = await app.inject({ method: "POST", url: "/mock/bank/top-ups", payload: REMIT, headers: signed("POST", "/mock/remittance/incoming", REMIT) });
    expect(otherPath.statusCode).toBe(401);
    const stale = await app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: REMIT, headers: signed("POST", "/mock/remittance/incoming", REMIT, now() - 600) });
    expect(stale.statusCode).toBe(401);
    const wrongKey = await app.inject({
      method: "POST",
      url: "/mock/remittance/incoming",
      payload: REMIT,
      headers: { [MOCK_REQUEST_AUTH_HEADER]: mockRequestAuth("not-the-secret", "POST", "/mock/remittance/incoming", JSON.stringify(REMIT), now()) },
    });
    expect(wrongKey.statusCode).toBe(401);
    // A webhook-style signature over the same body is not a request signature.
    const webhookStyle = await app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: REMIT, headers: mockWebhookHeaders(SECRET, JSON.stringify(REMIT), now()) });
    expect(webhookStyle.statusCode).toBe(401);
  });

  it("keeps the outbox and the QR attack switch for the operator: a Kassa signature is not enough", async () => {
    expect((await app.inject({ method: "GET", url: "/mock/outbox", headers: signed("GET", "/mock/outbox") })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/mock/outbox", headers: { [DEMO_TOKEN_HEADER]: "wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/mock/outbox", headers: { [DEMO_TOKEN_HEADER]: TOKEN } })).statusCode).toBe(200);
    const swap = await app.inject({ method: "POST", url: "/mock/qr/attack/swap", payload: { enabled: true }, headers: { [DEMO_TOKEN_HEADER]: TOKEN } });
    expect(swap.statusCode).toBe(200);
    expect(w.qr.swapAll).toBe(true);
    w.qr.swapAll = false;
    const reset = await app.inject({ method: "POST", url: "/mock/reset", payload: {}, headers: { [DEMO_TOKEN_HEADER]: TOKEN } });
    expect(reset.statusCode).toBe(200);
  });

  it("leaves pages, catalogs, the till and the QR wallet's capability link public", async () => {
    for (const url of ["/mock/health", "/mock/", "/mock/shop/bud/menu", "/mock/suppliers", "/mock/schools", "/mock/shop/bud/till", "/mock/stage"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    const index = await app.inject({ method: "GET", url: "/mock/" });
    expect(index.body).not.toContain("/mock/outbox");
    const bill = await app.inject({ method: "POST", url: "/mock/shop/bud/bills", payload: { items: [{ sku: "PZ-MARG", qty: 1 }] } });
    expect(bill.statusCode, bill.body).toBe(201);
    // The API creates the code (signed); the paying user opens its page and pays without a credential.
    const body = { merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY" };
    const qr = await app.inject({ method: "POST", url: "/mock/qr/payments", payload: body, headers: signed("POST", "/mock/qr/payments", body) });
    expect(qr.statusCode, qr.body).toBe(201);
    const paymentId = qr.json().paymentId as string;
    expect((await app.inject({ method: "GET", url: `/mock/qr/${paymentId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/mock/qr/${paymentId}/pay`, payload: {} })).statusCode).toBe(200);
  });

  it("keeps every customer's orders and purchase orders for the operator; the till's own bill stays a capability (2026-10-19)", async () => {
    // A delivery order and a purchase order exist (made by Kassa).
    const orderBody = { items: [{ sku: "PZ-MARG", qty: 1 }], deliveryAddress: "Somewhere 1", payment: { method: "QR" } };
    const order = await app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: orderBody, headers: signed("POST", "/mock/shop/bud/orders", orderBody) });
    expect(order.statusCode, order.body).toBe(201);
    const orderId = order.json().order.orderId as string;
    const po = "6b0c7a1e-5d2f-4c3b-9a8e-1f2d3c4b5a69";
    const anonymous: [string, string, unknown?][] = [
      ["GET", "/mock/shop/bud/orders"],
      ["GET", `/mock/shop/bud/orders/${orderId}`],
      ["POST", `/mock/shop/bud/orders/${orderId}/advance`, {}],
      ["GET", "/mock/supplier/c/purchase-orders"],
      ["POST", `/mock/supplier/c/purchase-orders/${po}/confirm`, {}],
      ["POST", `/mock/supplier/c/purchase-orders/${po}/deliver`, {}],
      ["POST", `/mock/supplier/c/purchase-orders/${po}/invoice`, {}],
      ["POST", "/mock/supplier/d/attack/swapped-invoice", { purchaseOrderId: po }],
      ["GET", "/mock/supplier/c/invoices/inv_1234/invoice.pdf"],
    ];
    for (const [method, url, payload] of anonymous) {
      const res = await app.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    // A Kassa signature is not enough for the operator screens.
    expect((await app.inject({ method: "GET", url: "/mock/shop/bud/orders", headers: signed("GET", "/mock/shop/bud/orders") })).statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/mock/shop/bud/orders", headers: { [DEMO_TOKEN_HEADER]: TOKEN } });
    expect(list.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/mock/supplier/c/purchase-orders", headers: { [DEMO_TOKEN_HEADER]: TOKEN } })).statusCode).toBe(200);
    // The pages themselves load (they ask for the key), and the till's bill is readable by its id.
    for (const url of ["/mock/shop/bud/kitchen", "/mock/supplier/c/portal"]) {
      const page = await app.inject({ method: "GET", url });
      expect(page.statusCode, url).toBe(200);
      expect(page.body).toContain("opFetch");
    }
    const bill = (await app.inject({ method: "POST", url: "/mock/shop/bud/bills", payload: { items: [{ sku: "PZ-MARG", qty: 1 }] } })).json().bill;
    const view = await app.inject({ method: "GET", url: `/mock/shop/bud/bills/${bill.billId}` });
    expect(view.statusCode).toBe(200);
    // Who pays and how (the QR payment id) is not in the public view.
    expect(view.json().bill).not.toHaveProperty("payment");
    expect(view.json().bill).not.toHaveProperty("clientRef");
  });

  it("names only routes that exist", () => {
    for (const key of Object.keys(ROUTE_ACCESS)) {
      const [method, url] = key.split(" ") as [string, string];
      expect(app.hasRoute({ method: method as "GET", url }), key).toBe(true);
    }
  });
});

describe("unlocked mock world (local development)", () => {
  it("answers the control routes without a credential", async () => {
    const w = await world({ NODE_ENV: "development" });
    expect(w.app.initialConfig).toBeDefined();
    const res = await w.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: REMIT });
    expect(res.statusCode).toBe(202);
    await w.app.close();
  });
});

describe("config: a deployed build fails closed on the HMAC secret", () => {
  it("is locked on JUDGE_MODE and on Vercel, not in development or tests", () => {
    expect(loadConfig({ ...baseEnv, NODE_ENV: "development", JUDGE_MODE: "true" } as NodeJS.ProcessEnv).locked).toBe(true);
    expect(loadConfig({ ...baseEnv, NODE_ENV: "development", VERCEL: "1" } as NodeJS.ProcessEnv).locked).toBe(true);
    expect(loadConfig({ ...baseEnv, NODE_ENV: "development" } as NodeJS.ProcessEnv).locked).toBe(false);
    expect(loadConfig({ ...baseEnv, NODE_ENV: "test" } as NodeJS.ProcessEnv).locked).toBe(false);
  });

  it("refuses a missing or development-default secret when locked", () => {
    const dev = "dev-only-mock-hmac-secret-change-me";
    expect(() => loadConfig({ ...baseEnv, MOCK_HMAC_SECRET: "", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/MOCK_HMAC_SECRET/);
    expect(() => loadConfig({ ...baseEnv, MOCK_HMAC_SECRET: dev, NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/development default/);
    expect(() => loadConfig({ ...baseEnv, MOCK_HMAC_SECRET: dev, VERCEL: "1" } as NodeJS.ProcessEnv)).toThrow(/MOCK_HMAC_SECRET/);
    expect(() => loadConfig({ ...baseEnv, MOCK_HMAC_SECRET: "", JUDGE_MODE: "true" } as NodeJS.ProcessEnv)).toThrow(/MOCK_HMAC_SECRET/);
    expect(loadConfig({ ...baseEnv, MOCK_HMAC_SECRET: "", NODE_ENV: "development" } as NodeJS.ProcessEnv).hmacSecret).toBe(dev);
  });
});
