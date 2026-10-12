/*
 * Business M5: signed PO → supplier portal (confirm / deliver / invoice, signed "supplier" webhooks) → three-way
 * match → obligation ONCE + proposal (ASK T2 bank transfer in Budapest, QR HANDOFF in Shanghai) → paid → PO PAID.
 * Refusals: an invoice above the signed total (INVOICE_ABOVE_PO) and one asking for another account
 * (INVOICE_ACCOUNT_MISMATCH) propose nothing.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, SEED_NOW } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, notifications, obligations, payments, proposals, stockMovements } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { wireExecutor } from "../../src/modules/orders/wiring.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { approveOrder, getOrderView } from "../../src/modules/rules/index.ts";
import { useTestApp } from "../helpers/app.ts";
import { draftBoxes, ownerPasskey, poRow, portal, signPo } from "../helpers/business.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

beforeEach(async () => {
  await t.reset();
  clock.freezeForTests(new Date(SEED_NOW));
  offlineEnvironment();
  setRailOverridesForTests({});
  wireExecutor();
  mw = await startMockWorld({ env: { DEMO_ENABLED: "true" }, api: app });
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
});
afterEach(async () => {
  clock.freezeForTests(null);
  await mw.close();
});

async function signedAndConfirmed(slug: "bud" | "sha", supplier: "a" | "c", supplierPayeeId: string, packs: number) {
  const ids = BUSINESS_IDS[slug];
  const auth = await ownerPasskey(ids.user, slug === "bud" ? "HUF" : "CNY");
  const poId = await draftBoxes(slug, supplierPayeeId, packs);
  const signed = await signPo(app(), ids.user, auth, poId);
  expect(signed.statusCode, signed.body).toBe(200);
  expect(signed.json().status).toBe("SENT");
  expect(mw.suppliers.get(poId)?.supplierId).toBe(supplier);
  const c = await portal(mw, app(), supplier, poId, "confirm");
  expect(c.map((d) => d.statusCode), JSON.stringify(c)).toEqual([200]);
  expect((await poRow(poId)).status).toBe("CONFIRMED");
  return { auth, poId, userId: ids.user };
}

describe("M5 invoice three-way match", () => {
  it("Budapest: delivered + invoiced → ASK bank transfer with the signed PO → SENT → PO PAID", async () => {
    const { auth, poId, userId } = await signedAndConfirmed("bud", "a", BUSINESS_IDS.bud.payees.supplierA, 1);
    await portal(mw, app(), "a", poId, "deliver");
    const receipt = await getDb().select().from(stockMovements).where(and(eq(stockMovements.kind, "RECEIPT"), eq(stockMovements.ref, `PURCHASE_ORDER:${poId}`)));
    expect(receipt.map((r) => [r.sku, r.qty])).toEqual([["BOX-33CM", 100]]);
    // A repeated delivery report changes nothing.
    expect((await poRow(poId)).status).toBe("DELIVERED");

    const inv = await portal(mw, app(), "a", poId, "invoice");
    expect(inv[0]!.statusCode, JSON.stringify(inv[0]!.json)).toBe(200);
    const po = await poRow(poId);
    expect(po.status).toBe("INVOICED");
    expect(po.obligationId).not.toBeNull();
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, po.proposalId!));
    expect(p!.decision).toBe("ASK");
    expect(p!.reasonCodes).not.toContain("PO_NOT_DELIVERED");
    expect(p!.canonicalOrder).toMatchObject({ rail: "BANK_TRANSFER", purchaseOrderId: poId, amountMinor: 1_890_000, currency: "HUF", obligationId: po.obligationId });
    const [ob] = await getDb().select().from(obligations).where(eq(obligations.id, po.obligationId!));
    expect(ob!.recurrence).toBe("ONCE");

    const v = await getOrderView(userId, p!.id);
    const r = await approveOrder(userId, p!.id, auth.assert(v.orderHash));
    expect(r.paymentStatus, JSON.stringify(r)).toBe("PROCESSING");
    expect((await poRow(poId)).status).toBe("PAYING");
    // The mock bank moves the transfer on the demo clock: processing → … → outgoing_payment_sent.
    clock.freezeForTests(new Date(Date.parse(SEED_NOW) + 10 * 60_000));
    await mw.bank.tick();
    await deliverWebhooks(mw, app());
    expect((await getDb().select().from(payments).where(eq(payments.id, r.paymentId!)))[0]!.status).toBe("SENT");
    expect((await poRow(poId)).status).toBe("PAID");
    expect((await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "PO_PAID"))).length).toBe(1);
  });

  it("Shanghai: invoice before delivery → HANDOFF with PO_NOT_DELIVERED; QR paid → PO PAID", async () => {
    const { auth, poId, userId } = await signedAndConfirmed("sha", "c", BUSINESS_IDS.sha.payees.supplierC, 4);
    await portal(mw, app(), "c", poId, "invoice");
    const po = await poRow(poId);
    expect(po.status).toBe("INVOICED");
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, po.proposalId!));
    expect(p!.decision).toBe("HANDOFF");
    expect(p!.reasonCodes).toContain("PO_NOT_DELIVERED");
    expect(p!.canonicalOrder).toMatchObject({ rail: "HANDOFF", purchaseOrderId: poId, amountMinor: 72_000, currency: "CNY", payeeName: "Restaurant Supplier from China" });

    await portal(mw, app(), "c", poId, "deliver");
    expect((await poRow(poId)).status).toBe("INVOICED");
    const receipt = await getDb().select().from(stockMovements).where(eq(stockMovements.ref, `PURCHASE_ORDER:${poId}`));
    expect(receipt.map((m) => m.qty)).toEqual([400]);

    const v = await getOrderView(userId, p!.id);
    const [shown] = await getDb().select().from(proposals).where(eq(proposals.id, p!.id));
    expect(shown!.draft.handoffQr).toMatchObject({ check: "MATCH", qrAmountMinor: 72_000 });
    const r = await approveOrder(userId, p!.id, auth.assert(v.orderHash));
    expect(r.paymentStatus, JSON.stringify(r)).toBe("PROCESSING");
    mw.pending.length = 0;
    expect((await mw.app.inject({ method: "POST", url: `/mock/qr/${shown!.draft.handoffQr!.qrPaymentId}/pay`, payload: {} })).statusCode).toBe(200);
    await deliverWebhooks(mw, app());
    expect((await getDb().select().from(payments).where(eq(payments.id, r.paymentId!)))[0]!.status).toBe("SENT");
    expect((await poRow(poId)).status).toBe("PAID");
  });

  it("an invoice above the signed total is refused (INVOICE_ABOVE_PO): no obligation, no proposal, owner notified", async () => {
    const { poId } = await signedAndConfirmed("sha", "c", BUSINESS_IDS.sha.payees.supplierC, 4);
    const out = await portal(mw, app(), "c", poId, "invoice", { amountMinor: 72_001 });
    expect(out[0]!.json).toMatchObject({ refused: true, reasonCodes: ["INVOICE_ABOVE_PO"] });
    const po = await poRow(poId);
    expect(po).toMatchObject({ status: "CONFIRMED", obligationId: null, proposalId: null });
    expect(po.reasonCodes).toContain("INVOICE_ABOVE_PO");
    expect(await getDb().select().from(proposals)).toHaveLength(0);
    const notes = await getDb().select().from(notifications).where(eq(notifications.kind, "BUSINESS_INVOICE_REFUSED"));
    expect(notes.map((n) => n.userId)).toEqual([BUSINESS_IDS.sha.user]);
  });

  it("a payment for a PO whose stored core was altered after signing is refused by payments", async () => {
    const { auth, poId, userId } = await signedAndConfirmed("bud", "a", BUSINESS_IDS.bud.payees.supplierA, 1);
    await portal(mw, app(), "a", poId, "invoice");
    const po = await poRow(poId);
    const { purchaseOrders } = await import("../../src/db/schema.ts");
    await getDb().update(purchaseOrders).set({ core: { ...po.core!, totalMinor: po.core!.totalMinor * 2, lines: po.core!.lines.map((l) => ({ ...l, packs: l.packs * 2, lineTotalMinor: l.lineTotalMinor * 2 })) } }).where(eq(purchaseOrders.id, poId));
    const v = await getOrderView(userId, po.proposalId!);
    const r = await approveOrder(userId, po.proposalId!, auth.assert(v.orderHash));
    expect(r.paymentId).toBeNull();
    expect(r.reasonCodes).toContain("BAD_SIGNATURE");
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});
