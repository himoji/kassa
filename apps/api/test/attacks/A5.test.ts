/*
 * A5 — swapped QR (spec §19, §11 handoff). The supplier's real QR request is swapped for a code that names an
 * unknown payee in another country (mock world, POST /mock/qr/attack/swap). Expected: the handoff check is
 * QR_PAYEE_MISMATCH, the order is CANCELED with no Pay button (walletUrl null), no money moves, and if the user
 * pays the swapped code anyway, the wallet's webhook is recorded as a mismatch and never marks the payment SENT.
 * The control case (swap off) shows the same order is MATCH and payable, so the mismatch comes from the swap.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments } from "../../src/db/schema.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { ledgerOf, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SUPPLIERS, SWAPPED_QR_PAYEE } from "../../../mock-world/src/world/data.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

const ZERO_MONEY = { livePayments: 0, sentPayments: 0, kassaTransactions: 0 };

async function setSwap(enabled: boolean): Promise<void> {
  const res = await mw.app.inject({ method: "POST", url: "/mock/qr/attack/swap", payload: { enabled } });
  expect(res.statusCode).toBe(200);
}

/** A HANDOFF order to supplier B (the user has chosen handoff mode), proposed by the agent. */
async function proposeHandoff() {
  const { userId, auth } = await createUserWithPasskey({ moneyMode: "HANDOFF" });
  const supplier = await addPayee(userId, { name: SUPPLIERS.b.name, kind: "SUPPLIER", account: SUPPLIERS.b.iban, currency: "HUF" });
  const p = await proposeOrder({ userId, createdBy: "AGENT", payeeId: supplier.id, amountMinor: 1_390_000, currency: "HUF", purpose: "Dough restock" });
  expect(p.decision).toBe("HANDOFF");
  return { userId, auth, supplier, proposalId: p.proposalId };
}

describe("A5: swapped QR code (payee name mismatch)", () => {
  beforeAll(async () => {
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw.close();
  });
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    // The real handoff rail talks to the mock world through the transport startMockWorld installed.
    setRailOverridesForTests({});
  });

  it("a swapped QR gives QR_PAYEE_MISMATCH: the order is CANCELED, the handoff view has no pay action, nothing moves", async () => {
    await setSwap(true);
    const { userId, auth, proposalId } = await proposeHandoff();
    const view = await getOrderView(userId, proposalId);
    const res = await approveOrder(userId, proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("CANCELED");
    expect(res.reasonCodes).toEqual(["QR_PAYEE_MISMATCH"]);

    const [pay] = await getDb().select().from(payments).where(eq(payments.userId, userId));
    expect(pay).toBeDefined();
    expect(pay!.id).toBe(res.paymentId);
    expect(pay!.status).toBe("CANCELED");

    const handoff = await app().inject({ method: "GET", url: `/api/handoff/${pay!.id}`, headers: await bearer(userId) });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({
      check: "QR_PAYEE_MISMATCH",
      walletUrl: null,
      qrPayeeName: SWAPPED_QR_PAYEE.name,
      verifiedPayeeName: SUPPLIERS.b.name,
      reasonCodes: expect.arrayContaining(["QR_PAYEE_MISMATCH"]),
    });

    expect(await moneyMoved()).toEqual(ZERO_MONEY);
    const statusEntries = (await ledgerWithReason("PAYMENT_STATUS", "QR_PAYEE_MISMATCH")).filter((e) => (e.payload as { paymentId?: string }).paymentId === pay!.id);
    expect(statusEntries).toHaveLength(1);

    recordGuarded("A5", {
      case: "swapped QR at handoff: order canceled, no pay button",
      outcome: "BLOCKED",
      decision: "HANDOFF",
      reasonCodes: ["QR_PAYEE_MISMATCH"],
      ledger: ["PAYMENT_STATUS"],
    });
  });

  it("if the user pays the swapped code in the wallet anyway, the webhook is a recorded mismatch and never SENT", async () => {
    await setSwap(true);
    const { userId, auth, proposalId } = await proposeHandoff();
    const view = await getOrderView(userId, proposalId);
    await approveOrder(userId, proposalId, auth.assert(view.orderHash));
    const [pay] = await getDb().select().from(payments).where(eq(payments.userId, userId));
    const qrPaymentId = (pay!.details as { qrPaymentId: string }).qrPaymentId;

    const paid = await mw.app.inject({ method: "POST", url: `/mock/qr/${qrPaymentId}/pay`, payload: {} });
    expect(paid.statusCode).toBe(200);
    const delivered = await deliverWebhooks(mw, app());
    const qr = delivered.find((d) => d.kind === "qr");
    expect(qr).toBeDefined();
    expect(qr!.statusCode).toBe(200);
    expect(qr!.json).toMatchObject({ reasonCodes: expect.arrayContaining(["QR_PAYEE_MISMATCH"]) });

    const [after] = await getDb().select().from(payments).where(eq(payments.id, pay!.id));
    expect(after!.status).not.toBe("SENT");
    expect(after!.status).toBe("CANCELED");
    expect(await ledgerOf("HANDOFF_PAID_MISMATCH")).toHaveLength(1);
    const m = await moneyMoved();
    expect(m.sentPayments).toBe(0);
    expect(m.kassaTransactions).toBe(0);
    expect(m).toEqual(ZERO_MONEY);

    recordGuarded("A5", {
      case: "swapped QR paid anyway in the wallet: webhook recorded as mismatch, never SENT",
      outcome: "BLOCKED",
      decision: "HANDOFF",
      reasonCodes: ["QR_PAYEE_MISMATCH"],
      ledger: ["HANDOFF_PAID_MISMATCH", "PAYMENT_STATUS"],
    });
  });

  it("control: with the swap off the same order is MATCH, payable and PROCESSING (the mismatch comes from the swap)", async () => {
    await setSwap(false);
    const { userId, auth, proposalId } = await proposeHandoff();
    const view = await getOrderView(userId, proposalId);
    const res = await approveOrder(userId, proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");
    expect(res.reasonCodes).toEqual([]);

    const [pay] = await getDb().select().from(payments).where(eq(payments.userId, userId));
    const handoff = await app().inject({ method: "GET", url: `/api/handoff/${pay!.id}`, headers: await bearer(userId) });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({ check: "MATCH", qrPayeeName: SUPPLIERS.b.name, verifiedPayeeName: SUPPLIERS.b.name });
    expect(handoff.json().walletUrl).toEqual(expect.any(String));
    expect(await ledgerOf("HANDOFF_PAID_MISMATCH")).toHaveLength(0);
  });
});
