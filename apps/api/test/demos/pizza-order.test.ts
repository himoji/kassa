/*
 * (M2) "Order me 2 pizzas", the full loop, against the real mock world in process:
 * REPLAY turn (pizza-order.json) → search_catalog on the Budapest storefront → propose_order with the shop's SKUs and
 * prices as the signed fulfillment (itemsHash) → passkey approval → one-time card → the commerce hook submits the order
 * to the shop, which charges the card ONCE through Kassa's issuer → shop_orders RECEIVED → kitchen advances to
 * DELIVERED via signed "shop" webhooks; the merchant's stock goes down by recipe once. A second charge on the card is
 * declined. Plus the Shanghai variant (region CN): the shop order is created first and paid with the shop's QR code.
 */
import { randomUUID } from "node:crypto";

import { itemsHash } from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, IDS, MOCK_BANK_PROFILE_ID } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { issuedCards, ledgerEntries, notifications, payments, proposals, shopOrders, stockMovements, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { loadRecording } from "../../src/modules/agent/replay.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { wireExecutor } from "../../src/modules/orders/wiring.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment, signBaseRules, useRealCardDebit } from "../helpers/fixtures.ts";
import { deliverWebhooks, postSignedWebhook, startMockWorld, stubCatalogFetch, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";
import { drain } from "../intel/fakes.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

beforeAll(async () => {
  await ensureIntelTables(t.db());
});

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  // Real rails (card issuing, handoff) and the commerce hooks around them; card charges debit the mock bank wallet.
  setRailOverridesForTests({});
  useRealCardDebit();
  wireExecutor();
  mw = await startMockWorld({ env: { DEMO_ENABLED: "true" }, api: app });
  stubCatalogFetch(mw);
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
});
afterEach(async () => {
  await mw.close();
});

async function passkey(userId: string, homeCurrency: string): Promise<SoftAuthenticator> {
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth, homeCurrency);
  return auth;
}

async function turn(userId: string, text: string) {
  const conversationId = randomUUID();
  const h = await startTurn({ ports: dbPorts(userId, conversationId), store: dbTurnStore(conversationId, userId), text, mode: "REPLAY", emit: () => undefined, replayChunkDelayMs: 0 });
  await drain(h.uiStream);
  return h.done;
}

/** Approve with the passkey when rules asked (ASK / HANDOFF); AUTO already executed. */
async function approveIfAsked(userId: string, auth: SoftAuthenticator, proposalId: string) {
  const p = (await getDb().select().from(proposals).where(eq(proposals.id, proposalId)))[0]!;
  if (p.status !== "PENDING_APPROVAL") return null;
  const v = await getOrderView(userId, proposalId);
  return approveOrder(userId, proposalId, auth.assert(v.orderHash));
}

const MARG2 = [{ sku: "PZ-MARG", qty: 2, unitPriceMinor: 299_000, name: "Margherita" }];

describe("M2 pizza order, Budapest (one-time card)", () => {
  it("the recording parses", () => {
    expect(loadRecording("pizza-order")?.turns[0]?.userText).toBe("Order me 2 pizzas");
  });

  it("REPLAY turn → storefront fulfillment signed → card charged once by the shop → RECEIVED … DELIVERED; second charge declined", async () => {
    const auth = await passkey(IDS.user, "KZT");
    const huf = async () => (await mw.bank.listBalances(MOCK_BANK_PROFILE_ID)).find((b) => b.currency === "HUF")!.amount.valueMinor;
    const hufBefore = await huf();
    const s = await turn(IDS.user, "Order me 2 pizzas");
    expect(s.toolCalls.map((c) => c.toolName)).toEqual(["search_catalog", "propose_order"]);

    const [p] = await getDb().select().from(proposals).where(eq(proposals.userId, IDS.user));
    expect(p!.draft).toMatchObject({ payeeId: IDS.payees.pizzaShop, amountMinor: 598_000, currency: "HUF", fulfillment: { merchant: "bud", channel: "DELIVERY", items: MARG2 } });
    expect(p!.decision).not.toBe("REFUSE");
    expect(p!.canonicalOrder).toMatchObject({ rail: "CARD_ISSUING", payeeName: "Pizza Shop in Budapest", itemsHash: itemsHash(MARG2) });

    await approveIfAsked(IDS.user, auth, p!.id);

    // The shop charged the one-time card exactly once, through Kassa's issuer (approved).
    const charges = mw.app && ((await mw.app.inject({ method: "GET", url: "/mock/shop/bud/charges" })).json().charges as { cardId: string; amountMinor: number; result: { approved: boolean } }[]);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amountMinor: 598_000, result: { approved: true } });
    const [card] = await getDb().select().from(issuedCards).where(eq(issuedCards.userId, IDS.user));
    expect(card!.stripeCardId).toBe(charges[0]!.cardId);
    expect(card!.usedAt).not.toBeNull();
    const [pay] = await getDb().select().from(payments).where(eq(payments.proposalId, p!.id));
    expect(pay!.status).toBe("SENT");
    // (2026-10-19) The charge was paid from the wallet's HUF balance, and the authorization ledgers the debit.
    expect(await huf()).toBe(hufBefore - 598_000);
    const auths = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "CARD_AUTHORIZATION"));
    expect(auths.map((e) => e.payload)).toEqual([expect.objectContaining({ approved: true, walletDebit: { currency: "HUF", amountMinor: 598_000, replayed: false } })]);

    const [row] = await getDb().select().from(shopOrders).where(eq(shopOrders.proposalId, p!.id));
    expect(row).toMatchObject({ userId: IDS.user, merchantSlug: "bud", merchantId: BUSINESS_IDS.bud.merchant, channel: "DELIVERY", status: "RECEIVED", totalMinor: 598_000, paymentId: pay!.id });
    expect(row!.externalOrderId).toMatch(/^ord_/);

    // A second charge on the same card is declined by Kassa's issuer.
    const again = await mw.app.inject({ method: "POST", url: "/mock/shop/bud/checkout", payload: { cardId: card!.stripeCardId, items: [{ sku: "PZ-MARG", quantity: 2 }] } });
    expect(again.statusCode).toBe(402);
    expect(again.json()).toMatchObject({ status: "declined", reasonCode: "CARD_ALREADY_USED" });
    expect(await huf()).toBe(hufBefore - 598_000);

    // Kitchen: ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED, each reported by a signed webhook.
    for (let i = 0; i < 4; i++) {
      expect((await mw.app.inject({ method: "POST", url: `/mock/shop/bud/orders/${row!.externalOrderId}/advance` })).statusCode).toBe(200);
    }
    const delivered = await deliverWebhooks(mw, app());
    expect(delivered.filter((d) => d.kind === "shop").every((d) => d.statusCode === 200)).toBe(true);

    const res = await app().inject({ method: "GET", url: `/api/shop-orders?proposalId=${p!.id}`, headers: await bearer(IDS.user) });
    expect(res.statusCode).toBe(200);
    const [view] = res.json().shopOrders;
    expect(view).toMatchObject({ status: "DELIVERED", final: true, merchantName: "Pizza Shop in Budapest", channel: "DELIVERY" });
    expect(view.timeline.map((x: { status: string }) => x.status)).toEqual(["SUBMITTED", "RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"]);
    expect((await app().inject({ method: "GET", url: `/api/shop-orders/${row!.id}`, headers: await bearer(IDS.user) })).json().status).toBe("DELIVERED");
    // BOLA: the pizzeria owner cannot read the customer's order.
    expect((await app().inject({ method: "GET", url: `/api/shop-orders/${row!.id}`, headers: await bearer(BUSINESS_IDS.bud.user) })).statusCode).toBe(404);

    // The merchant's sale: one set of SALE movements for this order (2 pizzas: 2 boxes, 2 dough balls ...).
    const sale = await getDb().select().from(stockMovements).where(and(eq(stockMovements.merchantId, BUSINESS_IDS.bud.merchant), eq(stockMovements.ref, `SHOP_ORDER:${row!.id}`)));
    expect(sale.length).toBeGreaterThan(0);
    expect(sale.find((m) => m.sku === "BOX-33CM")?.qty).toBe(-2);

    const notes = (await getDb().select().from(notifications).where(eq(notifications.userId, IDS.user))).filter((n) => n.kind === "SHOP_ORDER_STATUS");
    expect(notes.map((n) => (n.data as { status: string }).status)).toEqual(["RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"]);
  });

  it("webhooks are idempotent and forward-only; a forged total is refused; an unsigned one is 401", async () => {
    const auth = await passkey(IDS.user, "KZT");
    const r = await proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId: IDS.payees.pizzaShop, amountMinor: 598_000, currency: "HUF", purpose: "Pizza", fulfillment: { merchant: "bud", channel: "DELIVERY", items: MARG2 } });
    await approveIfAsked(IDS.user, auth, r.proposalId);
    const [row] = await getDb().select().from(shopOrders).where(eq(shopOrders.proposalId, r.proposalId));
    expect(row!.status).toBe("RECEIVED");
    await deliverWebhooks(mw, app()); // the shop's own RECEIVED: no change

    const base = { type: "shop.order.updated", storeId: "bud", orderId: row!.externalOrderId, clientRef: r.proposalId, items: [], totalMinor: 598_000, currency: "HUF" };
    const regress = await postSignedWebhook(app(), "shop", { ...base, eventId: randomUUID(), status: "AWAITING_PAYMENT" });
    expect(regress.json()).toMatchObject({ matched: true, changed: false });
    const forged = await postSignedWebhook(app(), "shop", { ...base, eventId: randomUUID(), status: "ACCEPTED", totalMinor: 1 });
    expect(forged.statusCode).toBe(409);
    const unsigned = await app().inject({ method: "POST", url: "/api/webhooks/mock/shop", payload: { ...base, status: "DELIVERED" } });
    expect(unsigned.statusCode).toBe(401);
    expect((await getDb().select().from(shopOrders).where(eq(shopOrders.id, row!.id)))[0]!.status).toBe("RECEIVED");
    // The sale is recorded once even if the paid status is reported again.
    const sale = await getDb().select().from(stockMovements).where(eq(stockMovements.ref, `SHOP_ORDER:${row!.id}`));
    expect(sale.filter((m) => m.sku === "BOX-33CM")).toHaveLength(1);
  });

  it("rules refuse a fulfillment whose items do not total the amount (nothing proposed)", async () => {
    await expect(
      proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId: IDS.payees.pizzaShop, amountMinor: 500_000, currency: "HUF", purpose: "Pizza", fulfillment: { merchant: "bud", channel: "DELIVERY", items: MARG2 } }),
    ).rejects.toMatchObject({ code: "BAD_FULFILLMENT" });
    expect(await getDb().select().from(proposals).where(eq(proposals.userId, IDS.user))).toHaveLength(0);
  });

  it("an order whose stored items no longer hash to the signed itemsHash is never sent to the shop", async () => {
    const auth = await passkey(IDS.user, "KZT");
    const r = await proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId: IDS.payees.pizzaShop, amountMinor: 598_000, currency: "HUF", purpose: "Pizza", agentRequestedConfirm: true, fulfillment: { merchant: "bud", channel: "DELIVERY", items: MARG2 } });
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(p!.status).toBe("PENDING_APPROVAL");
    // Tamper with the draft after signing-time hashing: 2 Pepperoni at the same total.
    await getDb()
      .update(proposals)
      .set({ draft: { ...p!.draft, fulfillment: { merchant: "bud", channel: "DELIVERY", items: [{ sku: "PZ-PEPP", qty: 2, unitPriceMinor: 299_000 }] } } })
      .where(eq(proposals.id, r.proposalId));
    await approveIfAsked(IDS.user, auth, r.proposalId);
    expect((await mw.app.inject({ method: "GET", url: "/mock/shop/bud/charges" })).json().charges).toHaveLength(0);
    expect(await getDb().select().from(shopOrders)).toHaveLength(0);
    const refused = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "FULFILLMENT_REFUSED"));
    expect(refused).toHaveLength(1);
  });
});

describe("M2 pizza order, Shanghai variant (region CN, QR handoff)", () => {
  it("the shop order is created first, paid with the shop's own QR code, then RECEIVED", async () => {
    const userId = BUSINESS_IDS.liWeiCn.user;
    const auth = await passkey(userId, "CNY");
    const items = [{ sku: "PZ-MARG", qty: 2, unitPriceMinor: 6_800, name: "Margherita" }];
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: BUSINESS_IDS.liWeiCn.payees.pizzaShopSh, amountMinor: 13_600, currency: "CNY", purpose: "Pizza", fulfillment: { merchant: "sha", channel: "DELIVERY", items } });
    expect(r.decision).toBe("HANDOFF");

    // Shown → preflight: the shop order exists and the QR checked is the shop's code for it.
    const v = await getOrderView(userId, r.proposalId);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(p!.draft.handoffQr).toMatchObject({ check: "MATCH", qrPayeeName: "Pizza Shop in Shanghai", qrAmountMinor: 13_600, qrCurrency: "CNY" });
    const [row] = await getDb().select().from(shopOrders).where(eq(shopOrders.proposalId, r.proposalId));
    expect(row).toMatchObject({ merchantSlug: "sha", merchantId: BUSINESS_IDS.sha.merchant, status: "AWAITING_PAYMENT" });
    const shopOrder = mw.shop.getOrder("sha", row!.externalOrderId!);
    expect(shopOrder?.payment.qrPaymentId).toBe(p!.draft.handoffQr!.qrPaymentId);

    const approved = await approveOrder(userId, r.proposalId, auth.assert(v.orderHash));
    expect(approved.paymentStatus).toBe("PROCESSING");
    expect((await getDb().select().from(shopOrders).where(eq(shopOrders.id, row!.id)))[0]!.paymentId).toBe(approved.paymentId);

    // The customer pays the shop's QR code in the wallet: QR webhook (payment SENT), then the shop's RECEIVED.
    mw.pending.length = 0;
    expect((await mw.app.inject({ method: "POST", url: `/mock/qr/${p!.draft.handoffQr!.qrPaymentId}/pay`, payload: {} })).statusCode).toBe(200);
    const out = await deliverWebhooks(mw, app());
    expect(out.map((o) => [o.kind, o.statusCode])).toEqual([
      ["qr", 200],
      ["shop", 200],
    ]);
    expect((await getDb().select().from(payments).where(eq(payments.id, approved.paymentId!)))[0]!.status).toBe("SENT");
    expect((await getDb().select().from(shopOrders).where(eq(shopOrders.id, row!.id)))[0]!.status).toBe("RECEIVED");
    const sale = await getDb().select().from(stockMovements).where(eq(stockMovements.ref, `SHOP_ORDER:${row!.id}`));
    expect(sale.find((m) => m.sku === "BOX-33CM")?.qty).toBe(-2);
  });
});
