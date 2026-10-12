/*
 * (M3) Second phone as the counter till: the cashier creates a bill on the till (mock world), the customer opens
 * /pay/<billId> and Kassa proposes exactly the bill the till reports (amount, items and merchant fetched server side;
 * the client sends nothing but the id). The M2 hook pays it with the one-time card; the till turns PAID (green), or
 * DECLINED with the reason (red). A till sale lowers the merchant's stock. CN variant: the till's own QR code.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, IDS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { proposals, shopOrders, stockMovements, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { wireExecutor } from "../../src/modules/orders/wiring.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { approveOrder, getOrderView } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  setRailOverridesForTests({});
  wireExecutor();
  mw = await startMockWorld({ env: { DEMO_ENABLED: "true", KASSA_APP_URL: "https://kassa.test" }, api: app });
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

async function createBill(store: string, items: { sku: string; qty: number }[]) {
  const res = await mw.app.inject({ method: "POST", url: `/mock/shop/${store}/bills`, payload: { items } });
  expect(res.statusCode).toBe(201);
  return res.json().bill as { billId: string; totalMinor: number; payUrl: string };
}

async function propose(userId: string, billId: string, payload?: object) {
  return app().inject({ method: "POST", url: `/api/merchant-bills/${billId}/propose`, headers: await bearer(userId), ...(payload ? { payload } : {}) });
}

async function approveIfAsked(userId: string, auth: SoftAuthenticator, proposalId: string) {
  const p = (await getDb().select().from(proposals).where(eq(proposals.id, proposalId)))[0]!;
  if (p.status !== "PENDING_APPROVAL") return;
  const v = await getOrderView(userId, proposalId);
  await approveOrder(userId, proposalId, auth.assert(v.orderHash));
}

describe("M3 counter till (Budapest, one-time card)", () => {
  it("bill → propose (server-side amount) → approve → card charged → till PAID; stock down; second propose 409", async () => {
    const auth = await passkey(IDS.user, "KZT");
    const bill = await createBill("bud", [
      { sku: "PZ-PEPP", qty: 1 },
      { sku: "DR-COLA", qty: 2 },
    ]);
    expect(bill.payUrl).toBe(`https://kassa.test/pay/${bill.billId}`);

    const view = await app().inject({ method: "GET", url: `/api/merchant-bills/${bill.billId}`, headers: await bearer(IDS.user) });
    expect(view.json()).toMatchObject({ merchantSlug: "bud", merchantName: "Pizza Shop in Budapest", totalMinor: 487_000, currency: "HUF", status: "OPEN" });

    // Whatever the client sends is ignored: amount and merchant come from the till.
    const res = await propose(IDS.user, bill.billId, { amountMinor: 1, currency: "EUR", payeeId: IDS.payees.landlord });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bill.totalMinor).toBe(487_000);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, body.proposalId));
    expect(p!.draft).toMatchObject({ payeeId: IDS.payees.pizzaShop, amountMinor: 487_000, currency: "HUF", fulfillment: { merchant: "bud", channel: "TILL", billId: bill.billId } });

    // Scanning again while pending returns the same proposal.
    if (p!.status === "PENDING_APPROVAL") expect((await propose(IDS.user, bill.billId)).json().proposalId).toBe(body.proposalId);

    await approveIfAsked(IDS.user, auth, body.proposalId);
    expect(mw.shop.getBill("bud", bill.billId)).toMatchObject({ status: "PAID" });
    const [row] = await getDb().select().from(shopOrders).where(eq(shopOrders.proposalId, body.proposalId));
    expect(row).toMatchObject({ channel: "TILL", billId: bill.billId, status: "PAID", merchantId: BUSINESS_IDS.bud.merchant });
    expect((await deliverWebhooks(mw, app())).every((d) => d.statusCode === 200)).toBe(true);

    const sale = await getDb().select().from(stockMovements).where(eq(stockMovements.ref, `TILL_BILL:${row!.id}`));
    expect(sale.find((m) => m.sku === "BOX-33CM")?.qty).toBe(-1);

    const again = await propose(IDS.user, bill.billId);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("BILL_ALREADY_PAID");
  });

  it("Kassa refuses (frozen account): the till shows DECLINED with the reason; nothing charged", async () => {
    await passkey(IDS.user, "KZT");
    await getDb().update(users).set({ frozenAt: new Date() }).where(eq(users.id, IDS.user));
    const bill = await createBill("bud", [{ sku: "PZ-MARG", qty: 1 }]);
    const res = await propose(IDS.user, bill.billId);
    expect(res.json()).toMatchObject({ decision: "REFUSE" });
    expect(mw.shop.getBill("bud", bill.billId)).toMatchObject({ status: "DECLINED", reasonCode: res.json().reasonCodes[0] });
    expect((await mw.app.inject({ method: "GET", url: "/mock/shop/bud/charges" })).json().charges).toHaveLength(0);
  });

  it("unknown bill → 404; malformed id → 400; a merchant the user never added → 422", async () => {
    expect((await propose(IDS.user, "bud-00000000000000000000")).statusCode).toBe(404);
    expect((await propose(IDS.user, "not a bill")).statusCode).toBe(400);
    const sha = await createBill("sha", [{ sku: "DR-COLA", qty: 1 }]);
    const r = await propose(IDS.user, sha.billId);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("MERCHANT_NOT_A_PAYEE");
  });
});

describe("M3 counter till, Shanghai (QR handoff)", () => {
  it("the till's own QR code is checked and paid; the bill turns PAID", async () => {
    const userId = BUSINESS_IDS.liWeiCn.user;
    const auth = await passkey(userId, "CNY");
    const bill = await createBill("sha", [{ sku: "PZ-4CHE", qty: 1 }]);
    const body = (await propose(userId, bill.billId)).json();
    expect(body.decision).toBe("HANDOFF");
    const v = await getOrderView(userId, body.proposalId);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, body.proposalId));
    expect(p!.draft.handoffQr).toMatchObject({ check: "MATCH", qrAmountMinor: 8_800 });
    expect(mw.shop.getBill("sha", bill.billId)!.payment?.qrPaymentId).toBe(p!.draft.handoffQr!.qrPaymentId);
    await approveOrder(userId, body.proposalId, auth.assert(v.orderHash));
    mw.pending.length = 0;
    await mw.app.inject({ method: "POST", url: `/mock/qr/${p!.draft.handoffQr!.qrPaymentId}/pay`, payload: {} });
    expect((await deliverWebhooks(mw, app())).map((d) => [d.kind, d.statusCode])).toEqual([
      ["qr", 200],
      ["shop", 200],
    ]);
    expect(mw.shop.getBill("sha", bill.billId)!.status).toBe("PAID");
    const [row] = await getDb().select().from(shopOrders).where(eq(shopOrders.proposalId, body.proposalId));
    expect(row!.status).toBe("PAID");
  });
});
