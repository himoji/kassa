/*
 * A5 — swapped QR (spec §19, §11 handoff). The supplier's real QR request is swapped for a code that names an
 * unknown payee in another country (mock world, POST /mock/qr/attack/swap). Expected (X7, cn report note 1): the
 * QR is fetched and checked when the order is SHOWN (GET /orders/:id), before the passkey prompt: QR_PAYEE_MISMATCH
 * up front, nothing to sign, approve refused, no payment row. The post-payment check stays: a code that matched
 * when shown but whose wallet payment names someone else is recorded as a mismatch and never marks the payment SENT.
 * The control case (swap off) shows the same order is MATCH and payable, so the mismatch comes from the swap.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments, proposals } from "../../src/db/schema.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { ledgerOf, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment, useRealHandoff } from "../helpers/fixtures.ts";
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
    // The real handoff rail + QR preflight talk to the mock world through the transport startMockWorld installed.
    useRealHandoff();
  });

  it("a swapped QR is caught when the order is shown: QR_PAYEE_MISMATCH up front, nothing to sign, approve refused, nothing moves", async () => {
    await setSwap(true);
    const { userId, auth, proposalId } = await proposeHandoff();
    const shown = await app().inject({ method: "GET", url: `/api/orders/${proposalId}`, headers: await bearer(userId) });
    expect(shown.statusCode).toBe(200);
    const view = shown.json();
    expect(view.webauthnOptions).toBeNull(); // no passkey prompt
    expect(view.status).toBe("REFUSED");
    expect(view.reasonCodes).toContain("QR_PAYEE_MISMATCH");
    expect(view.handoff).toMatchObject({ check: "QR_PAYEE_MISMATCH", qrPayeeName: SWAPPED_QR_PAYEE.name, verifiedPayeeName: SUPPLIERS.b.name });

    const approve = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: await bearer(userId), payload: { assertion: auth.assert(view.orderHash) } });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().code).toBe("QR_PAYEE_MISMATCH");

    expect(await getDb().select().from(payments).where(eq(payments.userId, userId))).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO_MONEY);
    expect(await ledgerWithReason("HANDOFF_MISMATCH", "QR_PAYEE_MISMATCH")).toHaveLength(1);

    recordGuarded("A5", {
      case: "swapped QR caught when the order is shown: no passkey prompt, approve refused",
      decision: "HANDOFF",
      reasonCodes: ["QR_PAYEE_MISMATCH"],
      ledger: ["HANDOFF_MISMATCH"],
    });
  });

  it("post-payment check kept: a code that matched when shown but is paid to another name is a recorded mismatch, never SENT", async () => {
    await setSwap(false);
    const { userId, auth, proposalId } = await proposeHandoff();
    const view = await getOrderView(userId, proposalId);
    expect(view.handoff?.check).toBe("MATCH");
    const res = await approveOrder(userId, proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");
    const [pay] = await getDb().select().from(payments).where(eq(payments.userId, userId));
    const qrPaymentId = (pay!.details as { qrPaymentId: string }).qrPaymentId;

    const paid = await mw.app.inject({ method: "POST", url: `/mock/qr/${qrPaymentId}/pay`, payload: {} });
    expect(paid.statusCode).toBe(200);
    // The wallet reports a different beneficiary than the checked QR (swapped between showing and paying).
    for (const w of mw.pending) if (w.kind === "qr") (w.body as { payeeName: string }).payeeName = SWAPPED_QR_PAYEE.name;
    const delivered = await deliverWebhooks(mw, app());
    const qr = delivered.find((d) => d.kind === "qr");
    expect(qr!.statusCode).toBe(200);
    expect(qr!.json).toMatchObject({ reasonCodes: expect.arrayContaining(["QR_PAYEE_MISMATCH"]) });

    const [after] = await getDb().select().from(payments).where(eq(payments.id, pay!.id));
    expect(after!.status).toBe("FAILED");
    expect(await ledgerOf("HANDOFF_PAID_MISMATCH")).toHaveLength(1);
    const m = await moneyMoved();
    expect(m.sentPayments).toBe(0);
    expect(m.kassaTransactions).toBe(0);

    recordGuarded("A5", {
      case: "QR swapped after it was shown and paid anyway: webhook recorded as mismatch, never SENT",
      decision: "HANDOFF",
      reasonCodes: ["QR_PAYEE_MISMATCH"],
      ledger: ["HANDOFF_PAID_MISMATCH", "PAYMENT_STATUS"],
      // Handoff: the user's own wallet moves the money. Kassa detects the swap afterwards; it cannot stop it.
      paid: true,
      note: "The QR matched when shown and the user approved it; the code was swapped afterwards and the wallet paid another name. Kassa only detects it (HANDOFF_PAID_MISMATCH, never marked SENT): the money is gone unless the wallet or bank reverses it.",
    });
  });

  it("control: with the swap off the same order is MATCH, payable and PROCESSING (the mismatch comes from the swap)", async () => {
    await setSwap(false);
    const { userId, auth, proposalId } = await proposeHandoff();
    const view = await getOrderView(userId, proposalId);
    expect(view.handoff).toMatchObject({ check: "MATCH", qrPayeeName: SUPPLIERS.b.name });
    const res = await approveOrder(userId, proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");
    expect(res.reasonCodes).toEqual([]);
    // The QR the user saw before signing is the one they pay (no second QR request at execution).
    const [paid] = await getDb().select().from(payments).where(eq(payments.userId, userId));
    const [prop] = await getDb().select().from(proposals).where(eq(proposals.id, proposalId));
    expect((paid!.details as { qrPaymentId: string }).qrPaymentId).toBe(prop!.draft.handoffQr?.qrPaymentId);

    const [pay] = await getDb().select().from(payments).where(eq(payments.userId, userId));
    const handoff = await app().inject({ method: "GET", url: `/api/handoff/${pay!.id}`, headers: await bearer(userId) });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({ check: "MATCH", qrPayeeName: SUPPLIERS.b.name, verifiedPayeeName: SUPPLIERS.b.name });
    expect(handoff.json().walletUrl).toEqual(expect.any(String));
    expect(await ledgerOf("HANDOFF_PAID_MISMATCH")).toHaveLength(0);
  });
});
