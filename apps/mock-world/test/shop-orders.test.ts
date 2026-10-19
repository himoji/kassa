/*
 * (M2/M3) Pizza shop order book: server-side pricing, card charge through the issuer (single use is the issuer's job),
 * QR-paid orders, status flow + signed "shop" webhooks, kitchen autopilot on the demo clock, counter till bills, and
 * the DEMO_ENABLED gate on the kitchen / till pages.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { AuthorizationRequest, Issuer } from "../src/shop/issuer.ts";
import { BILL_LEASE_MS } from "../src/shop/orders.ts";
import { RecordingSink } from "../src/webhooks.ts";

/** Single-use issuer: the first charge on a card is approved, every later one declined (like Kassa's issuing). */
class OneShotIssuer implements Issuer {
  readonly provider = "fake" as const;
  readonly seen = new Set<string>();
  readonly calls: AuthorizationRequest[] = [];
  async authorize(req: AuthorizationRequest) {
    this.calls.push(req);
    const used = this.seen.has(req.cardId);
    this.seen.add(req.cardId);
    return { approved: !used, provider: "fake" as const, authorizationId: `auth_${this.calls.length}`, reasonCode: used ? "CARD_ALREADY_USED" : null, issuerStatus: 200 };
  }
}

const clock = new ManualClock(Date.parse("2026-10-27T18:00:00Z"));

async function world(env: Record<string, string>) {
  const sink = new RecordingSink();
  const issuer = new OneShotIssuer();
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: "s3cret", KASSA_APP_URL: "https://kassa.test", ...env } as NodeJS.ProcessEnv),
    clock,
    webhooks: sink,
    rates: new StaticRates(),
    issuer,
    logger: false,
    startTicker: false,
  });
  return { w, sink, issuer };
}

let demo: { w: MockWorld; sink: RecordingSink; issuer: OneShotIssuer };
let plain: { w: MockWorld; sink: RecordingSink; issuer: OneShotIssuer };

beforeAll(async () => {
  demo = await world({ DEMO_ENABLED: "true", SHOP_AUTOPILOT: "true", SHOP_AUTOPILOT_STEP_SECONDS: "60" });
  plain = await world({});
});
afterAll(async () => {
  await demo.w.app.close();
  await plain.w.app.close();
});
beforeEach(() => {
  demo.w.shop.reset();
  demo.sink.sent.length = 0;
});

const shopEvents = (sink: RecordingSink) => sink.sent.filter((s) => s.kind === "shop").map((s) => s.body as Record<string, unknown>);

describe("delivery orders", () => {
  it("re-prices on the server, charges the card once, reports RECEIVED; the same card is declined on a second order", async () => {
    const app = demo.w.app;
    const res = await app.inject({
      method: "POST",
      url: "/mock/shop/bud/orders",
      payload: { clientRef: "p-1", items: [{ sku: "PZ-MARG", qty: 2 }], expectedTotalMinor: 598_000, payment: { method: "CARD", cardId: "fic_card_1" } },
    });
    expect(res.statusCode).toBe(201);
    const { order } = res.json();
    expect(order).toMatchObject({ status: "RECEIVED", totalMinor: 598_000, currency: "HUF", items: [{ sku: "PZ-MARG", qty: 2, unitPriceMinor: 299_000, name: "Margherita" }] });
    expect(order.payment).toMatchObject({ method: "CARD", cardHint: "rd_1" });
    expect(JSON.stringify(order)).not.toContain("fic_card_1");
    expect(demo.issuer.calls.at(-1)).toMatchObject({ amountMinor: 598_000, currency: "HUF", merchant: expect.objectContaining({ name: "Pizza Shop in Budapest" }) });
    expect(shopEvents(demo.sink)).toEqual([expect.objectContaining({ type: "shop.order.updated", storeId: "bud", orderId: order.orderId, clientRef: "p-1", status: "RECEIVED", totalMinor: 598_000 })]);

    // Idempotent per clientRef: no second charge.
    const again = await app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { clientRef: "p-1", items: [{ sku: "PZ-MARG", qty: 2 }], payment: { method: "CARD", cardId: "fic_card_1" } } });
    expect(again.statusCode).toBe(200);
    expect(again.json().order.orderId).toBe(order.orderId);
    expect(demo.issuer.calls.filter((c) => c.cardId === "fic_card_1")).toHaveLength(1);

    const second = await app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { clientRef: "p-2", items: [{ sku: "PZ-MARG", qty: 2 }], payment: { method: "CARD", cardId: "fic_card_1" } } });
    expect(second.statusCode).toBe(201);
    expect(second.json().order).toMatchObject({ status: "DECLINED", reasonCode: "CARD_ALREADY_USED" });
  });

  it("a total that differs from the signed amount is refused before any charge", async () => {
    const before = demo.issuer.calls.length;
    const res = await demo.w.app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { items: [{ sku: "PZ-MARG", qty: 2 }], expectedTotalMinor: 500_000, payment: { method: "CARD", cardId: "fic_card_2" } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("AMOUNT_MISMATCH");
    expect(demo.issuer.calls.length).toBe(before);
    const unknown = await demo.w.app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { items: [{ sku: "NOPE", qty: 1 }], payment: { method: "QR" } } });
    expect(unknown.statusCode).toBe(400);
  });

  it("kitchen advances RECEIVED → … → DELIVERED with a webhook per step; then 409", async () => {
    const app = demo.w.app;
    const { order } = (await app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { items: [{ sku: "PZ-PEPP", qty: 1 }], payment: { method: "CARD", cardId: "fic_card_3" } } })).json();
    for (const next of ["ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      const r = await app.inject({ method: "POST", url: `/mock/shop/bud/orders/${order.orderId}/advance` });
      expect(r.statusCode).toBe(200);
      expect(r.json().order.status).toBe(next);
    }
    expect((await app.inject({ method: "POST", url: `/mock/shop/bud/orders/${order.orderId}/advance` })).statusCode).toBe(409);
    expect(shopEvents(demo.sink).map((e) => e.status)).toEqual(["RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"]);
    const list = (await app.inject({ method: "GET", url: "/mock/shop/bud/orders" })).json().orders;
    expect(list[0].timeline.map((t: { status: string }) => t.status)).toEqual(["AWAITING_PAYMENT", "RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"]);
  });

  it("autopilot moves a paid order one step per step interval of demo time", async () => {
    const app = demo.w.app;
    const { order } = (await app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { items: [{ sku: "PZ-VEGE", qty: 1 }], payment: { method: "CARD", cardId: "fic_card_4" } } })).json();
    expect(await demo.w.shop.tick()).toBe(0);
    clock.advance(61_000);
    expect(await demo.w.shop.tick()).toBe(1);
    expect(demo.w.shop.getOrder("bud", order.orderId)!.status).toBe("ACCEPTED");
    for (let i = 0; i < 5; i++) {
      clock.advance(61_000);
      await demo.w.shop.tick();
    }
    expect(demo.w.shop.getOrder("bud", order.orderId)!.status).toBe("DELIVERED");
  });

  it("Shanghai QR order: AWAITING_PAYMENT with the shop's QR code; paying it in the wallet moves it to RECEIVED", async () => {
    const app = demo.w.app;
    const res = await app.inject({ method: "POST", url: "/mock/shop/sha/orders", payload: { clientRef: "p-cn", items: [{ sku: "PZ-MARG", qty: 2 }], expectedTotalMinor: 13_600, payment: { method: "QR" } } });
    expect(res.statusCode).toBe(201);
    const { order, qr } = res.json();
    expect(order).toMatchObject({ status: "AWAITING_PAYMENT", currency: "CNY", totalMinor: 13_600 });
    expect(qr).toMatchObject({ payeeName: "Pizza Shop in Shanghai", amountMinor: 13_600, currency: "CNY" });
    expect(shopEvents(demo.sink).map((e) => e.status)).toEqual(["AWAITING_PAYMENT"]);
    const paid = await app.inject({ method: "POST", url: `/mock/qr/${qr.paymentId}/pay`, payload: {} });
    expect(paid.statusCode).toBe(200);
    expect(demo.w.shop.getOrder("sha", order.orderId)!.status).toBe("RECEIVED");
    // QR webhook first (Kassa marks the payment), then the shop's RECEIVED.
    expect(demo.sink.sent.slice(-2).map((s) => s.kind)).toEqual(["qr", "shop"]);
  });
});

describe("counter till", () => {
  it("bill → QR link to the Kassa app; card pay → PAID; a second pay → 409; a declined card shows the reason", async () => {
    const app = demo.w.app;
    const created = await app.inject({ method: "POST", url: "/mock/shop/bud/bills", payload: { items: [{ sku: "DR-COLA", qty: 1 }, { sku: "DS-TIRA", qty: 1 }] } });
    expect(created.statusCode).toBe(201);
    const { bill } = created.json();
    expect(bill.billId).toMatch(/^bud-[0-9a-f]{20}$/);
    expect(bill).toMatchObject({ status: "OPEN", totalMinor: 198_000, currency: "HUF", payUrl: `https://kassa.test/pay/${bill.billId}` });

    const svg = await app.inject({ method: "GET", url: `/mock/shop/bud/bills/${bill.billId}/qr.svg` });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.body).toContain("<svg");

    const view = (await app.inject({ method: "GET", url: `/mock/shop/bud/bills/${bill.billId}` })).json();
    expect(view.merchant).toMatchObject({ storeId: "bud", name: "Pizza Shop in Budapest" });

    // Kassa reported a refusal first: red with the reason, still payable.
    const declined = await app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/decline`, payload: { reasonCode: "REFUSE_DAILY_CAP" } });
    expect(declined.json().bill).toMatchObject({ status: "DECLINED", reasonCode: "REFUSE_DAILY_CAP" });

    const pay = await app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/pay`, payload: { cardId: "fic_till_1", clientRef: "p-till", expectedTotalMinor: 198_000 } });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().bill).toMatchObject({ status: "PAID", clientRef: "p-till" });
    expect(shopEvents(demo.sink).map((e) => [e.type, e.status])).toEqual([
      ["shop.bill.updated", "DECLINED"],
      ["shop.bill.updated", "PAID"],
    ]);
    expect((await app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/pay`, payload: { cardId: "fic_till_2" } })).statusCode).toBe(409);

    const b2 = (await app.inject({ method: "POST", url: "/mock/shop/bud/bills", payload: { items: [{ sku: "DR-COLA", qty: 1 }] } })).json().bill;
    const reused = await app.inject({ method: "POST", url: `/mock/shop/bud/bills/${b2.billId}/pay`, payload: { cardId: "fic_till_1" } });
    expect(reused.json().bill).toMatchObject({ status: "DECLINED", reasonCode: "CARD_ALREADY_USED" });
  });

  it("Shanghai bill paid by the shop's QR code (one code per bill, for the order that asked first)", async () => {
    const app = demo.w.app;
    const { bill } = (await app.inject({ method: "POST", url: "/mock/shop/sha/bills", payload: { items: [{ sku: "PZ-4CHE", qty: 1 }] } })).json();
    const a = (await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/qr`, payload: { clientRef: "p-x", expectedTotalMinor: 8_800 } })).json();
    const again = (await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/qr`, payload: { clientRef: "p-x" } })).json();
    expect(a.qr.paymentId).toBe(again.qr.paymentId);
    // (2026-10-19) Another order (another customer) does not get the code while p-x holds the bill.
    const other = await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/qr`, payload: {} });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe("BILL_IN_PAYMENT");
    await app.inject({ method: "POST", url: `/mock/qr/${a.qr.paymentId}/pay`, payload: {} });
    expect(demo.w.shop.getBill("sha", bill.billId)).toMatchObject({ status: "PAID", clientRef: "p-x" });
  });

  it("pages render with the simulated banner when DEMO_ENABLED; kitchen, till and their actions are 404 otherwise", async () => {
    for (const path of ["/mock/shop/bud/kitchen", "/mock/shop/sha/till"]) {
      const on = await demo.w.app.inject({ method: "GET", url: path });
      expect(on.statusCode).toBe(200);
      expect(on.body).toContain("SIMULATED");
      expect((await plain.w.app.inject({ method: "GET", url: path })).statusCode).toBe(404);
    }
    expect((await plain.w.app.inject({ method: "POST", url: "/mock/shop/bud/bills", payload: { items: [{ sku: "DR-COLA", qty: 1 }] } })).statusCode).toBe(404);
    expect((await plain.w.app.inject({ method: "GET", url: "/mock/shop/bud/orders" })).statusCode).toBe(404);
    // The API-facing order endpoint is not a page: it works without the demo flag.
    const r = await plain.w.app.inject({ method: "POST", url: "/mock/shop/bud/orders", payload: { items: [{ sku: "DR-COLA", qty: 1 }], payment: { method: "QR" } } });
    expect(r.statusCode).toBe(201);
  });
});

describe("one payer per till bill (2026-10-19)", () => {
  const newBill = async (w: MockWorld, store = "bud") =>
    (await w.app.inject({ method: "POST", url: `/mock/shop/${store}/bills`, payload: { items: [{ sku: store === "bud" ? "PZ-MARG" : "PZ-4CHE", qty: 1 }] } })).json().bill as {
      billId: string;
      totalMinor: number;
    };

  it("two orders paying one bill at the same moment: one card is charged, the other order gets 409", async () => {
    // A slow issuer keeps the first charge in flight while the second request arrives.
    const sink = new RecordingSink();
    const calls: string[] = [];
    const slow: Issuer = {
      provider: "fake",
      authorize: async (req) => {
        calls.push(req.cardId);
        await new Promise((r) => setTimeout(r, 30));
        return { approved: true, provider: "fake", authorizationId: `auth_${calls.length}`, reasonCode: null, issuerStatus: 200 };
      },
    };
    const w = await buildMockWorld({
      config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: "s3cret", KASSA_APP_URL: "https://kassa.test", DEMO_ENABLED: "true" } as NodeJS.ProcessEnv),
      clock,
      webhooks: sink,
      rates: new StaticRates(),
      issuer: slow,
      logger: false,
      startTicker: false,
    });
    try {
      const bill = await newBill(w);
      const pay = (cardId: string, clientRef: string) => w.app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/pay`, payload: { cardId, clientRef, expectedTotalMinor: bill.totalMinor } });
      const [a, b] = await Promise.all([pay("fic_alice", "p-alice"), pay("fic_bob", "p-bob")]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json().code).toBe("BILL_IN_PAYMENT");
      expect(calls).toHaveLength(1);
      expect(sink.sent.filter((e) => (e.body as { type?: string }).type === "shop.bill.updated").map((e) => (e.body as { status: string }).status)).toEqual(["PAID"]);
      // After it is paid, every other order gets ALREADY_PAID.
      const late = await pay("fic_carol", "p-carol");
      expect(late.statusCode).toBe(409);
      expect(late.json().code).toBe("ALREADY_PAID");
    } finally {
      await w.app.close();
    }
  });

  it("a declined card gives the bill up: another order can pay it", async () => {
    const app = demo.w.app;
    const bill = await newBill(demo.w);
    demo.issuer.seen.add("fic_spent");
    const first = await app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/pay`, payload: { cardId: "fic_spent", clientRef: "p-1" } });
    expect(first.json().bill).toMatchObject({ status: "DECLINED", reasonCode: "CARD_ALREADY_USED" });
    const second = await app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/pay`, payload: { cardId: "fic_fresh_2", clientRef: "p-2" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().bill).toMatchObject({ status: "PAID", clientRef: "p-2" });
  });

  it("while one order's QR code holds the bill: no card charge, and another order's refusal does not turn the till red", async () => {
    const app = demo.w.app;
    const bill = await newBill(demo.w, "sha");
    const qr = (await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/qr`, payload: { clientRef: "p-qr" } })).json().qr;
    const card = await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/pay`, payload: { cardId: "fic_other_1", clientRef: "p-card" } });
    expect(card.statusCode).toBe(409);
    expect(demo.issuer.calls.some((c) => c.cardId === "fic_other_1")).toBe(false);
    const refused = await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/decline`, payload: { reasonCode: "REFUSE_DAILY_CAP", clientRef: "p-card" } });
    expect(refused.statusCode).toBe(409);
    expect(demo.w.shop.getBill("sha", bill.billId)?.status).toBe("OPEN");
    // The holder's own refusal gives the bill up (red), and it can be paid by another order afterwards.
    const own = await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/decline`, payload: { reasonCode: "QR_PAYEE_MISMATCH", clientRef: "p-qr" } });
    expect(own.json().bill).toMatchObject({ status: "DECLINED" });
    const paid = await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/pay`, payload: { cardId: "fic_other_2", clientRef: "p-card" } });
    expect(paid.json().bill).toMatchObject({ status: "PAID" });
    // The first order's code can no longer pay the bill.
    const late = await app.inject({ method: "POST", url: `/mock/qr/${qr.paymentId}/pay`, payload: {} });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("ALREADY_PAID");
  });

  it("an abandoned QR code expires: another order takes the bill, and the old code cannot pay it", async () => {
    const app = demo.w.app;
    const bill = await newBill(demo.w, "sha");
    const old = (await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/qr`, payload: { clientRef: "p-gone" } })).json().qr;
    const realNow = Date.now;
    const later = realNow() + BILL_LEASE_MS + 1_000;
    Date.now = () => later;
    try {
      const fresh = await app.inject({ method: "POST", url: `/mock/shop/sha/bills/${bill.billId}/qr`, payload: { clientRef: "p-new" } });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().qr.paymentId).not.toBe(old.paymentId);
      const stale = await app.inject({ method: "POST", url: `/mock/qr/${old.paymentId}/pay`, payload: {} });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("CODE_REPLACED");
      expect((await app.inject({ method: "POST", url: `/mock/qr/${fresh.json().qr.paymentId}/pay`, payload: {} })).statusCode).toBe(200);
      expect(demo.w.shop.getBill("sha", bill.billId)).toMatchObject({ status: "PAID", clientRef: "p-new" });
    } finally {
      Date.now = realNow;
    }
  });
});
