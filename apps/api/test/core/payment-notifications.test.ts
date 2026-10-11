/*
 * X9 (p1 B3, B5): only the rent bank transfer produced a "Payment sent" notice, and a generic one. Every payment
 * outcome now notifies once, on the common status transition: PAYMENT_SENT / PAYMENT_FAILED for bank transfers,
 * card charges and handoff payments, stored as {key, params} (i18n) plus English text: payee display name, amount in
 * the original and the home currency, rail, and "under mandate X" for T1 mandate payments.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { issuedCards, notifications, payments } from "../../src/db/schema.ts";
import { updatePaymentStatus } from "../../src/modules/payments/index.ts";
import { fakeCharge } from "../../src/modules/rails/issuing.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addActiveMandate, addObligation, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

type Note = typeof notifications.$inferSelect & { data: { key: string; params: Record<string, unknown>; paymentId: string } };

async function notesOf(userId: string, kind: string): Promise<Note[]> {
  return (await getDb().select().from(notifications).where(eq(notifications.userId, userId))).filter((n) => n.kind === kind) as Note[];
}

async function approvedOrder(opts: { payee: Parameters<typeof addPayee>[1]; amountMinor: number; currency: string; user?: Parameters<typeof createUserWithPasskey>[0] }) {
  const { userId, auth } = await createUserWithPasskey(opts.user);
  const payee = await addPayee(userId, opts.payee);
  const r = await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: opts.amountMinor, currency: opts.currency, purpose: "Test" });
  const v = await getOrderView(userId, r.proposalId);
  const res = await approveOrder(userId, r.proposalId, auth.assert(v.orderHash));
  return { userId, payee, paymentId: res.paymentId!, res };
}

describe("X9 payment outcome notifications", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
  });

  it("bank transfer SENT → one PAYMENT_SENT with payee, original + home amount, rail", async () => {
    const { userId, paymentId } = await approvedOrder({ payee: { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY }, amountMinor: 240_000, currency: "EUR" });
    expect(await notesOf(userId, "PAYMENT_SENT")).toHaveLength(0); // PROCESSING is not "sent"
    await updatePaymentStatus(paymentId, "SENT", { source: "test" });
    await updatePaymentStatus(paymentId, "SENT", { source: "test (duplicate event)" });
    const notes = await notesOf(userId, "PAYMENT_SENT");
    expect(notes).toHaveLength(1);
    const pay = (await getDb().select().from(payments).where(eq(payments.id, paymentId)))[0]!;
    expect(notes[0]!.data).toMatchObject({
      key: "payment.sent",
      paymentId,
      params: {
        payee: "University in Budapest",
        amount: { amountMinor: 240_000, currency: "EUR" },
        home: { amountMinor: pay.homeAmountMinor, currency: "KZT" },
        rail: "BANK_TRANSFER",
        mandate: null,
      },
    });
    expect(notes[0]!.title).toContain("University in Budapest");
    expect(notes[0]!.body).toMatch(/€2,400\.00/);
    expect(notes[0]!.body).toMatch(/₸|KZT/);
    expect(notes[0]!.body).toMatch(/bank transfer/i);
  });

  it("T1 mandate payment → the notice names the mandate", async () => {
    const { userId, auth } = await createUserWithPasskey();
    await signBaseRules(userId, auth);
    const landlord = await addPayee(userId, { name: "Landlord in Budapest" });
    const rent = await addObligation(userId, landlord.id);
    const m = await addActiveMandate(userId, auth, { payeeIds: [landlord.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
    const r = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: rent.id });
    expect(r.decision).toBe("AUTO");
    const pay = (await getDb().select().from(payments).where(eq(payments.proposalId, r.proposalId)))[0]!;
    await updatePaymentStatus(pay.id, "SENT", { source: "test" });
    const [n] = await notesOf(userId, "PAYMENT_SENT");
    expect(n!.data.params).toMatchObject({ payee: "Landlord in Budapest", rail: "BANK_TRANSFER", mandate: { id: m.mandateId, categories: ["rent"] } });
    expect(n!.body).toMatch(/under your signed mandate/i);
    expect(n!.body).toContain(m.mandateId.slice(0, 8));
  });

  it("card charge (one-time card, fake issuer) → PAYMENT_SENT with rail CARD_ISSUING", async () => {
    const { userId, paymentId, res } = await approvedOrder({ payee: { name: "Pizza Shop", kind: "MERCHANT", currency: "HUF", account: "pizza shop" }, amountMinor: 450_000, currency: "HUF", user: { moneyMode: "CAPPED_WALLET" } });
    expect(res.paymentStatus).toBe("PROCESSING");
    const card = (await getDb().select().from(issuedCards).where(eq(issuedCards.paymentId, paymentId)))[0]!;
    const d = await fakeCharge({ cardId: card.stripeCardId, amountMinor: 450_000, currency: "HUF", merchantName: "Pizza Shop" });
    expect(d.approved).toBe(true);
    const notes = await notesOf(userId, "PAYMENT_SENT");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data.params).toMatchObject({ payee: "Pizza Shop", rail: "CARD_ISSUING", amount: { amountMinor: 450_000, currency: "HUF" } });
    expect(notes[0]!.body).toMatch(/one-time card/i);
  });

  it("handoff payment SENT → PAYMENT_SENT with rail HANDOFF", async () => {
    const { userId, paymentId } = await approvedOrder({ payee: { name: "Dorm Office in Shanghai", kind: "MERCHANT", currency: "CNY", account: "dorm office" }, amountMinor: 180_000, currency: "CNY", user: { region: "CN" } });
    await updatePaymentStatus(paymentId, "SENT", { source: "test" });
    const [n] = await notesOf(userId, "PAYMENT_SENT");
    expect(n!.data.params).toMatchObject({ payee: "Dorm Office in Shanghai", rail: "HANDOFF", amount: { amountMinor: 180_000, currency: "CNY" } });
  });

  it("FAILED / CANCELED → one PAYMENT_FAILED with the reason codes; never a PAYMENT_SENT", async () => {
    const { userId, paymentId } = await approvedOrder({ payee: { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY }, amountMinor: 10_000, currency: "EUR" });
    await updatePaymentStatus(paymentId, "FAILED", { source: "test", reasonCodes: ["RAIL_ERROR"] });
    const failed = await notesOf(userId, "PAYMENT_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({ key: "payment.failed", paymentId, params: { payee: "University in Budapest", rail: "BANK_TRANSFER", reasonCodes: ["RAIL_ERROR"] } });
    expect(await notesOf(userId, "PAYMENT_SENT")).toHaveLength(0);
  });
});
