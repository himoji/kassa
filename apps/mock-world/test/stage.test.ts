import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mockWebhookHeaders, signMockWebhook } from "@kassa/shared";

import { buildMockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { type FetchLike, ManualClock } from "../src/clock.ts";
import { loadConfig, type MockWorldConfig } from "../src/config.ts";
import type { Issuer } from "../src/shop/issuer.ts";
import { RecordingSink } from "../src/webhooks.ts";

const TOKEN = "demo-admin-token-for-stage-tests-0123456789";
const SECRET = "hmac-secret-for-stage-tests-abcdef";
const API = "http://api.test";
const DEVICE_TOKEN = "ksc_test_device_token";
const DEMO_HEADER = "x-kassa-demo-token";
const TX_ID = "11111111-1111-4111-8111-111111111111";

const BANNED = ["Apple", "WeChat", "Alipay", "微信", "支付宝", "Revolut"];

const PAGES = [
  "/mock/stage",
  "/mock/stage/tap",
  "/mock/stage/wallet",
  "/mock/stage/mail",
  "/mock/stage/bank",
  "/mock/stage/home",
  "/mock/stage/supplier",
] as const;

const baseEnv = {
  API_URL: "http://api.test",
  MOCK_PUBLIC_URL: "http://mock.test",
  MOCK_HMAC_SECRET: SECRET,
  NODE_ENV: "test",
};

const config = loadConfig({ ...baseEnv, DEMO_ENABLED: "true", DEMO_ADMIN_TOKEN: TOKEN } as NodeJS.ProcessEnv);

const authorize = vi
  .fn()
  .mockResolvedValueOnce({ approved: true, provider: "fake", authorizationId: "auth_1", reasonCode: null, issuerStatus: 200 })
  .mockResolvedValueOnce({
    approved: false,
    provider: "fake",
    authorizationId: "auth_2",
    reasonCode: "CARD_ALREADY_USED",
    issuerStatus: 200,
  });
const fakeIssuer: Issuer = { provider: "fake" as const, authorize };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const CAPTURE_REPLY = {
  status: "LOGGED",
  transactionId: TX_ID,
  mergedIntoId: null,
  parsedBy: "PARSER:IOS_SHORTCUT",
  merchantNorm: "x",
  amountMinor: 420,
  currency: "EUR",
  homeAmountMinor: 257208,
  category: "eating_out",
  categorySource: "DICTIONARY",
  notification: { key: "budget.each", params: {}, en: { title: "Coffee", body: "€4.20 at Coffee Shop in Budapest" } },
};

const SETTLEMENT_REPLY = { transactionId: TX_ID, feeHomeMinor: 0, markupBps: 0, dcc: { overMidBps: 600 }, cardProfile: null };

const TRIGGER_REPLY = {
  now: "2026-10-27T09:00:00.000Z",
  clockOffsetMs: 0,
  agentMode: "REPLAY",
  result: { captured: [{ status: "LOGGED", amountMinor: 3250, currency: "CNY", homeAmountMinor: 239795 }] },
};

const CLOCK_REPLY = { now: "2026-10-27T09:00:00.000Z", clockOffsetMs: 0, agentMode: "REPLAY" };

function normaliseHeaders(h: RequestInit["headers"] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  let entries: [string, string][];
  if (Array.isArray(h)) entries = h.map((pair) => [String(pair[0]), String(pair[1])] as [string, string]);
  else if (h instanceof Headers) entries = [...h.entries()];
  else entries = Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v);
  return out;
}

/** A fake Kassa API behind StageApi's injected fetch. Records every call, answers by path. */
function makeFakeApi() {
  const calls: Call[] = [];
  const flags = { failNext: false, unauthorizeCaptureNext: false };
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, method, headers: normaliseHeaders(init?.headers), body });
    if (flags.failNext) {
      flags.failNext = false;
      throw new TypeError("fetch failed");
    }
    return answer(method, new URL(url).pathname, flags);
  });
  return { calls, flags, fetch };
}

type FakeApi = ReturnType<typeof makeFakeApi>;

function answer(method: string, path: string, flags: { unauthorizeCaptureNext: boolean }): Response {
  const reply = (status: number, x: unknown) =>
    new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && path === "/api/demo/stage/shortcut-token") {
    return reply(201, { deviceId: "22222222-2222-4222-8222-222222222222", token: DEVICE_TOKEN });
  }
  if (method === "POST" && path === "/api/capture/shortcut") {
    if (flags.unauthorizeCaptureNext) {
      flags.unauthorizeCaptureNext = false;
      return reply(401, { code: "DEVICE_TOKEN_INVALID" });
    }
    return reply(200, CAPTURE_REPLY);
  }
  if (method === "POST" && path === "/api/demo/stage/settlement") return reply(200, SETTLEMENT_REPLY);
  if (method === "POST" && path === "/api/demo/stage/document") return reply(200, { docId: "33333333-3333-4333-8333-333333333333" });
  if (method === "POST" && path.startsWith("/api/demo/trigger/")) return reply(200, TRIGGER_REPLY);
  if (method === "POST" && (path === "/api/demo/reset" || path === "/api/demo/clock/advance")) return reply(200, CLOCK_REPLY);
  if (method === "POST" && path === "/api/webhooks/mock/bank") return reply(401, { code: "WEBHOOK_SIGNATURE_INVALID", title: "Bad signature" });
  return reply(404, {});
}

const mainApi = makeFakeApi();
const mainSink = new RecordingSink();
const mainClock = new ManualClock(Date.parse("2026-10-27T09:00:00Z"));
const apps: FastifyInstance[] = [];
let app: FastifyInstance;
let offApp: FastifyInstance;
let offApi: FakeApi;
let noTokenApp: FastifyInstance;
let noTokenApi: FakeApi;

async function buildWorld(cfg: MockWorldConfig, api: FakeApi, clock: ManualClock, sink: RecordingSink): Promise<FastifyInstance> {
  const world = await buildMockWorld({
    config: cfg,
    clock,
    webhooks: sink,
    rates: new StaticRates(),
    issuer: fakeIssuer,
    logger: false,
    startTicker: false,
    fetch: api.fetch as FetchLike,
  });
  apps.push(world.app);
  return world.app;
}

beforeAll(async () => {
  app = await buildWorld(config, mainApi, mainClock, mainSink);
  offApi = makeFakeApi();
  offApp = await buildWorld(
    loadConfig({ ...baseEnv, DEMO_ENABLED: "false", DEMO_ADMIN_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    offApi,
    new ManualClock(Date.parse("2026-10-27T09:00:00Z")),
    new RecordingSink(),
  );
  noTokenApi = makeFakeApi();
  noTokenApp = await buildWorld(
    loadConfig({ ...baseEnv, DEMO_ENABLED: "true" } as NodeJS.ProcessEnv),
    noTokenApi,
    new ManualClock(Date.parse("2026-10-27T09:00:00Z")),
    new RecordingSink(),
  );
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

beforeEach(async () => {
  // Start every test from the seeded demo: resets bank, QR wallet, charges, pending DCC and the cached device token.
  mainApi.calls.length = 0;
  mainApi.flags.failNext = false;
  mainApi.flags.unauthorizeCaptureNext = false;
  mainSink.sent.length = 0;
  await app.inject({ method: "POST", url: "/mock/stage/api/reset" });
  mainApi.calls.length = 0;
});

function jsonOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

function expectClean(text: string): void {
  for (const word of BANNED) expect(text, `banned word "${word}"`).not.toContain(word);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("ksc_");
}

interface StageState {
  simulated: boolean;
  demoTokenConfigured: boolean;
  tap: { lastCardId: string | null; pendingDcc: unknown };
  wallet: { swapAll: boolean; latest: { paymentId: string; payeeName: string; swapped: boolean } | null };
}

async function stateOf(a: FastifyInstance): Promise<StageState> {
  const res = await a.inject({ method: "GET", url: "/mock/stage/api/state" });
  return JSON.parse(res.body) as StageState;
}

function act(a: FastifyInstance, action: string, payload: Record<string, unknown> = {}) {
  return a.inject({ method: "POST", url: `/mock/stage/api/${action}`, payload });
}

async function createQr(a: FastifyInstance): Promise<string> {
  const res = await a.inject({
    method: "POST",
    url: "/mock/qr/payments",
    payload: { merchantId: "dorm-office", amountMinor: 180000, currency: "CNY" },
  });
  expect(res.statusCode).toBe(201);
  return jsonOf(res).paymentId as string;
}

function callsTo(api: FakeApi, url: string): Call[] {
  return api.calls.filter((c) => c.url === url);
}

describe("screens", () => {
  it.each(PAGES)("GET %s renders the simulated frame", async (path) => {
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Simulated");
    expect(res.body).toContain("What Kassa does");
    expectClean(res.body);
  });

  it("serves the stage stylesheet and script without secrets", async () => {
    const css = await app.inject({ method: "GET", url: "/mock/stage/stage.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expectClean(css.body);

    const js = await app.inject({ method: "GET", url: "/mock/stage/stage.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expectClean(js.body);
  });

  it("wallet page is in Chinese, supplier page carries the hidden-text marker", async () => {
    const wallet = await app.inject({ method: "GET", url: "/mock/stage/wallet" });
    expect(wallet.body).toContain("zh-CN");
    expect(wallet.body).toContain("扫码付款");

    const supplier = await app.inject({ method: "GET", url: "/mock/stage/supplier" });
    expect(supplier.body).toContain("hidden-text");
  });

  it("mail page links attachments by same-origin path only", async () => {
    const res = await app.inject({ method: "GET", url: "/mock/stage/mail" });
    const links = [...res.body.matchAll(/href="([^"]*payees[^"]*)"/g)].map((m) => m[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.startsWith("/mock/payees/"), link).toBe(true);
    expect(res.body).not.toContain("http://mock.test");
  });
});

describe("state", () => {
  it("GET /mock/stage/api/state reports the demo as simulated with a token configured", async () => {
    const res = await app.inject({ method: "GET", url: "/mock/stage/api/state" });
    expect(res.statusCode).toBe(200);
    const body = jsonOf(res);
    expect(body.simulated).toBe(true);
    expect(body.demoTokenConfigured).toBe(true);
    expectClean(res.body);
  });
});

describe("scene 1: tap to pay", () => {
  it("tap-coffee mints a device token and posts the capture with it", async () => {
    const res = await act(app, "tap-coffee");
    expect(res.statusCode).toBe(200);
    expect(jsonOf(res)).toMatchObject({ ok: true, tone: "ok" });
    expectClean(res.body);

    expect(mainApi.calls).toHaveLength(2);
    const [mint, capture] = mainApi.calls as [Call, Call];
    expect(mint).toMatchObject({ url: `${API}/api/demo/stage/shortcut-token`, method: "POST" });
    expect(mint.headers[DEMO_HEADER]).toBe(TOKEN);
    expect(capture).toMatchObject({ url: `${API}/api/capture/shortcut`, method: "POST" });
    expect(capture.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(capture.body).toMatchObject({ merchant: "Coffee Shop in Budapest", currency: "EUR" });
    expect(String(capture.body?.amount)).toContain("4.20");
  });

  it("a second tap reuses the cached device token", async () => {
    await act(app, "tap-coffee");
    const second = await act(app, "tap-coffee");
    expect(jsonOf(second)).toMatchObject({ ok: true, tone: "ok" });
    expect(mainApi.calls.filter((c) => c.url === `${API}/api/demo/stage/shortcut-token`)).toHaveLength(1);
  });

  it("re-mints the device token once when the capture answers 401", async () => {
    await act(app, "tap-coffee");
    mainApi.calls.length = 0;
    mainApi.flags.unauthorizeCaptureNext = true;

    const res = await act(app, "tap-coffee");
    expect(jsonOf(res)).toMatchObject({ ok: true });
    expect(mainApi.calls.map((c) => c.url)).toEqual([
      `${API}/api/capture/shortcut`,
      `${API}/api/demo/stage/shortcut-token`,
      `${API}/api/capture/shortcut`,
    ]);
    expect(mainApi.calls[2]?.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it("tap-dcc logs the charge in KZT, then tap-dcc-settle flags the 6.00% markup", async () => {
    const dcc = await act(app, "tap-dcc");
    expect(jsonOf(dcc)).toMatchObject({ ok: true, tone: "warn" });

    const capture = callsTo(mainApi, `${API}/api/capture/shortcut`)[0];
    expect(capture?.body).toMatchObject({ currency: "KZT" });

    const settle = await act(app, "tap-dcc-settle");
    expect(settle.statusCode).toBe(200);
    const settleCall = callsTo(mainApi, `${API}/api/demo/stage/settlement`)[0];
    expect(settleCall?.body).toMatchObject({
      transactionId: TX_ID,
      localAmountMinor: 1299000,
      localCurrency: "HUF",
      currency: "KZT",
      settledCurrency: "KZT",
    });
    expect(settleCall?.body?.amountMinor).toBe(settleCall?.body?.settledAmountMinor);

    const settled = jsonOf(settle);
    expect(settled.tone).toBe("bad");
    expect(String(settled.title)).toContain("DCC");
    expect(String(settled.title)).toContain("6.00%");
    expectClean(settle.body);
  });

  it("a second tap-dcc-settle with nothing pending is a warning, not a crash", async () => {
    const res = await act(app, "tap-dcc-settle");
    expect(res.statusCode).toBe(200);
    expect(jsonOf(res)).toMatchObject({ ok: false, tone: "warn" });
  });

  it("tap-card: the one-time card is charged once, then refused", async () => {
    const first = await act(app, "tap-card", { cardId: "card_stage_1" });
    expect(jsonOf(first)).toMatchObject({ tone: "ok" });

    const second = await act(app, "tap-card", { cardId: "card_stage_1" });
    const declined = jsonOf(second);
    expect(declined.tone).toBe("bad");
    expect(String(declined.title)).toContain("CARD_ALREADY_USED");
    expectClean(second.body);

    expect((await stateOf(app)).tap.lastCardId).toBe("card_stage_1");
  });

  it("tap-card without a card id is a bad request", async () => {
    const res = await act(app, "tap-card", {});
    expect(res.statusCode).toBe(400);
  });
});

describe("scene 2: super-app wallet", () => {
  it("pays an honest QR, refuses a swapped one, and sends no webhook for the refusal", async () => {
    const firstId = await createQr(app);
    let state = await stateOf(app);
    expect(state.wallet.latest).toMatchObject({ paymentId: firstId, swapped: false });

    const paid = await act(app, "wallet-pay", { paymentId: firstId });
    expect(jsonOf(paid)).toMatchObject({ ok: true, tone: "ok" });
    expect(mainSink.sent.filter((e) => e.kind === "qr")).toHaveLength(1);

    expect((await act(app, "wallet-swap", { enabled: true })).statusCode).toBe(200);
    expect((await stateOf(app)).wallet.swapAll).toBe(true);

    // Same demo instant as the first code (fixed test clock): "latest" must still be the newer one.
    const swappedId = await createQr(app);
    state = await stateOf(app);
    expect(state.wallet.latest).toMatchObject({
      paymentId: swappedId,
      swapped: true,
      payeeName: "Unknown Trading Company",
    });

    const refused = await act(app, "wallet-pay", { paymentId: swappedId });
    expect(jsonOf(refused)).toMatchObject({ ok: false, tone: "bad" });
    expect(mainSink.sent.filter((e) => e.kind === "qr")).toHaveLength(1);

    expect((await act(app, "wallet-swap", { enabled: false })).statusCode).toBe(200);
  });

  it("wallet-notify triggers the CNY spending day with the demo token", async () => {
    const res = await act(app, "wallet-notify");
    expect(jsonOf(res)).toMatchObject({ ok: true });
    const trigger = callsTo(mainApi, `${API}/api/demo/trigger/cn-spending-day`)[0];
    expect(trigger?.headers[DEMO_HEADER]).toBe(TOKEN);
  });
});

describe("scene 3: mail", () => {
  it("forwards the tuition invoice as a PDF and the lookalike email as text, then triggers the IBAN notice", async () => {
    const invoice = await act(app, "mail-forward", { id: "msg-0001" });
    expect(jsonOf(invoice)).toMatchObject({ ok: true });
    const pdf = callsTo(mainApi, `${API}/api/demo/stage/document`)[0];
    expect(pdf?.body).toMatchObject({ mediaType: "application/pdf", kind: "invoice" });
    expect(Buffer.from(String(pdf?.body?.dataB64), "base64").subarray(0, 4).toString()).toBe("%PDF");

    mainApi.calls.length = 0;
    const lookalike = await act(app, "mail-forward", { id: "msg-0005" });
    expect(jsonOf(lookalike)).toMatchObject({ ok: true });
    const text = callsTo(mainApi, `${API}/api/demo/stage/document`)[0];
    expect(text?.body).toMatchObject({ mediaType: "text/plain", kind: "email_change_request" });
    expect(Buffer.from(String(text?.body?.dataB64), "base64").toString("utf8")).toContain("secure-payments-mail.example");
    expect(callsTo(mainApi, `${API}/api/demo/trigger/landlord-iban-email`)).toHaveLength(1);
    expectClean(lookalike.body);
  });

  it("refuses to forward a message that is not on the stage list", async () => {
    const res = await act(app, "mail-forward", { id: "msg-0002" });
    expect(res.statusCode).toBe(400);
    expect(mainApi.calls).toHaveLength(0);
  });
});

describe("scene 4: bank", () => {
  it("sends two forged bank messages, neither signed with the shared secret", async () => {
    const res = await act(app, "bank-forged");
    const body = jsonOf(res);
    expect(body).toMatchObject({ ok: true, tone: "ok", title: "Kassa rejected a forged bank message" });
    expectClean(res.body);

    const sent = callsTo(mainApi, `${API}/api/webhooks/mock/bank`);
    expect(sent).toHaveLength(2);
    const [unsigned, wrongKey] = sent as [Call, Call];
    expect(unsigned.headers).not.toHaveProperty("x-kassa-signature");

    expect(wrongKey.headers).toHaveProperty("x-kassa-signature");
    expect(wrongKey.headers).toHaveProperty("x-kassa-timestamp");
    const ts = Number(wrongKey.headers["x-kassa-timestamp"]);
    expect(wrongKey.headers["x-kassa-signature"]).not.toBe(signMockWebhook(SECRET, ts, JSON.stringify(wrongKey.body)));

    for (const c of sent) expect(c.headers).not.toHaveProperty(DEMO_HEADER);
  });
});

describe("scene 5: money from home and clock", () => {
  it("home-send, clock advance, bad clock hours, and reset all reach the API", async () => {
    const send = await act(app, "home-send");
    expect(jsonOf(send)).toMatchObject({ ok: true, tone: "ok" });
    expect(callsTo(mainApi, `${API}/api/demo/trigger/money-from-home`)).toHaveLength(1);

    mainApi.calls.length = 0;
    const advance = await act(app, "clock", { hours: 72 });
    expect(jsonOf(advance)).toMatchObject({ ok: true });
    const advanceCall = callsTo(mainApi, `${API}/api/demo/clock/advance`)[0];
    expect(advanceCall?.body).toEqual({ hours: 72 });

    const bad = await act(app, "clock", { hours: 5 });
    expect(bad.statusCode).toBe(400);

    mainApi.calls.length = 0;
    const reset = await act(app, "reset");
    expect(jsonOf(reset)).toMatchObject({ ok: true });
    expect(callsTo(mainApi, `${API}/api/demo/reset`)).toHaveLength(1);
  });
});

describe("connected world (M6)", () => {
  it("the director links the kitchens, till and supplier portals", async () => {
    const page = (await app.inject({ method: "GET", url: "/mock/stage" })).body;
    for (const href of ["/mock/shop/bud/kitchen", "/mock/shop/bud/till", "/mock/shop/sha/kitchen", "/mock/supplier/c/portal", "/mock/supplier/d/portal"]) {
      expect(page).toContain(`href="${href}"`);
    }
    expectClean(page);
  });

  it("kitchen-advance moves the newest paid order one step and reports it to Kassa", async () => {
    expect(jsonOf(await act(app, "kitchen-advance", { store: "bud" }))).toMatchObject({ ok: false, tone: "warn" });
    authorize.mockResolvedValueOnce({ approved: true, provider: "fake", authorizationId: "auth_k", reasonCode: null, issuerStatus: 200 });
    const created = await app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { items: [{ sku: "PZ-MARG", qty: 1 }], payment: { method: "CARD", cardId: "fic_card_k" } } });
    expect(created.json().order.status).toBe("RECEIVED");
    mainSink.sent.length = 0;
    const r = jsonOf(await act(app, "kitchen-advance", {}));
    expect(r).toMatchObject({ ok: true, data: { status: "ACCEPTED" } });
    expect(mainSink.sent.filter((e) => e.kind === "shop")).toHaveLength(1);
    expect((await act(app, "kitchen-advance", { store: "xyz" })).statusCode).toBe(400);
  });

  it("forecast-tick runs the business-forecast trigger with the demo token", async () => {
    const r = jsonOf(await act(app, "forecast-tick"));
    expect(r).toMatchObject({ ok: true, tone: "info" });
    const call = callsTo(mainApi, `${API}/api/demo/trigger/business-forecast`)[0];
    expect(call?.headers[DEMO_HEADER]).toBe(TOKEN);
  });

  it("supplier-attack: D invoices C's purchase order with its own payment details", async () => {
    expect(jsonOf(await act(app, "supplier-attack"))).toMatchObject({ ok: false, tone: "warn" });
    const poId = "44444444-4444-4444-8444-444444444444";
    const raw = JSON.stringify({
      purchaseOrderId: poId,
      poHash: "h",
      supplierName: "Restaurant Supplier from China",
      merchant: { slug: "sha", name: "Pizza Shop in Shanghai" },
      currency: "CNY",
      lines: [{ supplierSku: "BOX-33CM-100", packs: 1, packSize: 100, packPriceMinor: 9_000, lineTotalMinor: 9_000 }],
      totalMinor: 9_000,
      deliverBy: "2026-10-28",
    });
    const sent = await app.inject({
      method: "POST",
      url: "/mock/supplier/purchase-orders",
      payload: raw,
      headers: { "content-type": "application/json", ...mockWebhookHeaders(SECRET, raw, Math.floor((await mainClock.now()).getTime() / 1000)) },
    });
    expect(sent.statusCode).toBe(201);
    mainSink.sent.length = 0;
    const r = jsonOf(await act(app, "supplier-attack"));
    expect(r).toMatchObject({ ok: true, tone: "warn", data: { purchaseOrderId: poId } });
    const ev = mainSink.sent.filter((e) => e.kind === "supplier");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.body).toMatchObject({ type: "po.invoiced", invoice: { supplierName: "Restaurant Supplier from China", account: { scheme: "QR", payeeName: "Box Supplier from China" } } });
  });
});

describe("failures and guards", () => {
  it("answers 502 when the Kassa API is unreachable", async () => {
    mainApi.flags.failNext = true;
    const res = await act(app, "home-send");
    expect(res.statusCode).toBe(502);
    expect(jsonOf(res)).toMatchObject({ ok: false });
  });

  it("rejects an unknown action with 400", async () => {
    const res = await act(app, "pay-everything");
    expect(res.statusCode).toBe(400);
  });
});

describe("demo switched off", () => {
  it("answers 404 on every stage route and never calls the API", async () => {
    const gets = ["/mock/stage", "/mock/stage/tap", "/mock/stage/api/state"];
    for (const url of gets) {
      const res = await offApp.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
    for (const url of ["/mock/stage/api/reset", "/mock/stage/api/tap-coffee"]) {
      const res = await offApp.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
    expect(offApi.fetch).not.toHaveBeenCalled();
  });

  it("the index does not link to the stage", async () => {
    const res = await offApp.inject({ method: "GET", url: "/mock/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("/mock/stage");
  });
});

describe("demo on without an admin token", () => {
  it("reports no token and sends the trigger without the demo header", async () => {
    const state = await noTokenApp.inject({ method: "GET", url: "/mock/stage/api/state" });
    expect(jsonOf(state).demoTokenConfigured).toBe(false);

    const res = await act(noTokenApp, "home-send");
    expect(res.statusCode).toBe(200);
    const trigger = noTokenApi.calls.find((c) => c.url.includes("/api/demo/trigger/"));
    expect(trigger).toBeDefined();
    expect(trigger?.headers).not.toHaveProperty(DEMO_HEADER);
  });
});
