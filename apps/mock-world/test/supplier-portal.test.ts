/*
 * (M5) Supplier portal: Kassa's purchase orders arrive HMAC-signed (unsigned / stale → 401); confirm / deliver /
 * invoice send signed "supplier" webhooks in order; the invoice PDF renders; B and D can send a swapped-account
 * invoice for A's / C's orders; every portal route is 404 unless DEMO_ENABLED.
 */
import { mockWebhookHeaders } from "@kassa/shared";
import { afterAll, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { RecordingSink } from "../src/webhooks.ts";
import { ACCOUNTS, SUPPLIER_NAMES } from "../../../fixtures/seed-data.ts";

const SECRET = "s3cret";
const clock = new ManualClock(Date.parse("2026-10-27T18:00:00Z"));
const worlds: MockWorld[] = [];

async function world(demo: boolean) {
  const sink = new RecordingSink();
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: SECRET, DEMO_ENABLED: demo ? "true" : "false" } as NodeJS.ProcessEnv),
    clock,
    webhooks: sink,
    rates: new StaticRates(),
    logger: false,
    startTicker: false,
  });
  worlds.push(w);
  return { w, sink };
}
afterAll(async () => {
  for (const w of worlds) await w.app.close();
});

const PO = (id: string, supplierName: string) => ({
  purchaseOrderId: id,
  poHash: "h",
  supplierName,
  merchant: { slug: "bud", name: "Pizza Shop in Budapest" },
  currency: "HUF",
  lines: [{ supplierSku: "BOX-33CM-100", packs: 1, packSize: 100, packPriceMinor: 1_890_000, lineTotalMinor: 1_890_000 }],
  totalMinor: 1_890_000,
  deliverBy: "2026-10-28",
});

async function send(w: MockWorld, body: object, ts?: number) {
  const tsSeconds = ts ?? Math.floor((await clock.now()).getTime() / 1000);
  const raw = JSON.stringify(body);
  return w.app.inject({ method: "POST", url: "/mock/supplier/purchase-orders", payload: raw, headers: { "content-type": "application/json", ...mockWebhookHeaders(SECRET, raw, tsSeconds) } });
}

describe("supplier portal (M5)", () => {
  it("receives only signed POs; confirm → deliver → invoice send signed supplier webhooks; PDF renders", async () => {
    const { w, sink } = await world(true);
    const id = "11111111-1111-4111-8111-111111111111";
    expect((await w.app.inject({ method: "POST", url: "/mock/supplier/purchase-orders", payload: PO(id, SUPPLIER_NAMES.a) })).statusCode).toBe(401);
    expect((await send(w, PO(id, SUPPLIER_NAMES.a), 1)).statusCode).toBe(401);
    expect((await send(w, PO(id, SUPPLIER_NAMES.a))).statusCode).toBe(201);
    expect((await send(w, PO(id, SUPPLIER_NAMES.a))).statusCode).toBe(200);
    expect((await send(w, PO("22222222-2222-4222-8222-222222222222", "Unknown Supplier"))).statusCode).toBe(404);

    const base = `/mock/supplier/a/purchase-orders/${id}`;
    expect((await w.app.inject({ method: "POST", url: `${base}/invoice`, payload: {} })).statusCode).toBe(409);
    expect((await w.app.inject({ method: "POST", url: `${base}/confirm`, payload: {} })).statusCode).toBe(200);
    expect((await w.app.inject({ method: "POST", url: `${base}/deliver`, payload: {} })).statusCode).toBe(200);
    expect((await w.app.inject({ method: "POST", url: `${base}/deliver`, payload: {} })).statusCode).toBe(409);
    const inv = await w.app.inject({ method: "POST", url: `${base}/invoice`, payload: {} });
    expect(inv.statusCode).toBe(200);
    expect(sink.sent.map((s) => [s.kind, (s.body as { type: string }).type])).toEqual([
      ["supplier", "po.confirmed"],
      ["supplier", "po.delivered"],
      ["supplier", "po.invoiced"],
    ]);
    expect((sink.sent[2]!.body as { invoice: unknown }).invoice).toMatchObject({ supplierName: SUPPLIER_NAMES.a, amountMinor: 1_890_000, account: { scheme: "IBAN", iban: ACCOUNTS.supplierA } });
    const pdf = await w.app.inject({ method: "GET", url: `/mock/supplier/a/invoices/${inv.json().invoice.invoiceId}/invoice.pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await w.app.inject({ method: "GET", url: "/mock/supplier/a/portal" })).body).toContain("supplier portal");
  });

  it("B sends a swapped-account invoice for A's order; A has no attack; QR suppliers invoice to their QR merchant", async () => {
    const { w, sink } = await world(true);
    const id = "33333333-3333-4333-8333-333333333333";
    await send(w, PO(id, SUPPLIER_NAMES.a));
    expect((await w.app.inject({ method: "POST", url: "/mock/supplier/a/attack/swapped-invoice", payload: { purchaseOrderId: id } })).statusCode).toBe(404);
    const atk = await w.app.inject({ method: "POST", url: "/mock/supplier/b/attack/swapped-invoice", payload: { purchaseOrderId: id } });
    expect(atk.statusCode).toBe(200);
    expect((sink.sent.at(-1)!.body as { invoice: unknown }).invoice).toMatchObject({ supplierName: SUPPLIER_NAMES.a, account: { scheme: "IBAN", iban: ACCOUNTS.supplierB } });

    const cId = "44444444-4444-4444-8444-444444444444";
    await send(w, { ...PO(cId, SUPPLIER_NAMES.c), currency: "CNY", lines: [{ supplierSku: "BOX-33CM-100", packs: 4, packSize: 100, packPriceMinor: 18_000, lineTotalMinor: 72_000 }], totalMinor: 72_000 });
    await w.app.inject({ method: "POST", url: `/mock/supplier/c/purchase-orders/${cId}/confirm`, payload: {} });
    await w.app.inject({ method: "POST", url: `/mock/supplier/c/purchase-orders/${cId}/invoice`, payload: {} });
    expect((sink.sent.at(-1)!.body as { invoice: unknown }).invoice).toMatchObject({ account: { scheme: "QR", merchantId: "supplier-c", payeeName: SUPPLIER_NAMES.c } });
    await w.app.inject({ method: "POST", url: "/mock/supplier/d/attack/swapped-invoice", payload: { purchaseOrderId: cId } });
    expect((sink.sent.at(-1)!.body as { invoice: unknown }).invoice).toMatchObject({ supplierName: SUPPLIER_NAMES.c, account: { scheme: "QR", merchantId: "supplier-d" } });
  });

  it("portal routes are 404 unless DEMO_ENABLED", async () => {
    const { w } = await world(false);
    expect((await w.app.inject({ method: "GET", url: "/mock/supplier/a/portal" })).statusCode).toBe(404);
    expect((await w.app.inject({ method: "GET", url: "/mock/supplier/a/purchase-orders" })).statusCode).toBe(404);
    expect((await w.app.inject({ method: "POST", url: "/mock/supplier/b/attack/swapped-invoice", payload: { purchaseOrderId: "33333333-3333-4333-8333-333333333333" } })).statusCode).toBe(404);
  });
});
