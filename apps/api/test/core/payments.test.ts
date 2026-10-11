/* Payments independent verification (spec §7, I2/I4/I5/I9). */
import { orderHash } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, payees, payments, proposals, usedNonces, users, webauthnCredentialsPayments } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder, registerExecutor } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addActiveMandate, addObligation, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

/** Propose (ASK) and get a T2 approval WITHOUT executing it, so payments can be attacked directly. */
async function approvedButNotExecuted(amountMinor = 240_000) {
  const { userId, auth } = await createUserWithPasskey();
  const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
  const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor, currency: "EUR", purpose: "Tuition" });
  const view = await getOrderView(userId, r.proposalId);
  registerExecutor(null);
  const res = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
  offlineEnvironment();
  return { userId, auth, payee, proposalId: r.proposalId, approvalId: res.approvalId, orderHash: view.orderHash };
}

describe("payments verification", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
    clock.freezeForTests(null);
  });

  it("executes a valid T2 approval exactly once", async () => {
    const a = await approvedButNotExecuted();
    const r1 = await executeApproval(a.approvalId);
    expect(r1.status).toBe("PROCESSING");
    expect(r1.reasonCodes).toEqual([]);
    const r2 = await executeApproval(a.approvalId);
    expect(r2.reasonCodes).toEqual(["NONCE_USED"]); // I4
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });

  it("rejects a missing approval (NO_APPROVAL)", async () => {
    const r = await executeApproval("00000000-0000-4000-8000-000000000000");
    expect(r).toMatchObject({ paymentId: null, status: "FAILED", reasonCodes: ["NO_APPROVAL"] });
  });

  it("rejects a tampered approval signature (BAD_SIGNATURE)", async () => {
    const a = await approvedButNotExecuted();
    const row = (await getDb().select().from(approvals).where(eq(approvals.id, a.approvalId)))[0]!;
    const sig = Buffer.from(row.approvalSig, "base64url");
    sig[0] = sig[0]! ^ 0xff;
    await getDb().update(approvals).set({ approvalSig: sig.toString("base64url") }).where(eq(approvals.id, a.approvalId));
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["BAD_SIGNATURE"]);
  });

  it("rejects an approval whose signed fields were altered (tier upgrade)", async () => {
    const a = await approvedButNotExecuted();
    await getDb().update(approvals).set({ tier: "T1" }).where(eq(approvals.id, a.approvalId));
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["BAD_SIGNATURE"]);
  });

  it("rejects a tampered stored order (ORDER_HASH_MISMATCH, I3)", async () => {
    const a = await approvedButNotExecuted();
    const p = (await getDb().select().from(proposals).where(eq(proposals.id, a.proposalId)))[0]!;
    await getDb()
      .update(proposals)
      .set({ canonicalOrder: { ...p.canonicalOrder!, amountMinor: p.canonicalOrder!.amountMinor * 10 } })
      .where(eq(proposals.id, a.proposalId));
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["ORDER_HASH_MISMATCH"]);
  });

  it("rejects an expired approval (APPROVAL_EXPIRED)", async () => {
    const a = await approvedButNotExecuted();
    clock.setOffsetInMemoryForTests(6 * 60_000);
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["APPROVAL_EXPIRED"]);
    clock.setOffsetInMemoryForTests(0);
  });

  it("verifies T2 against its OWN credential store", async () => {
    const a = await approvedButNotExecuted();
    await getDb().delete(webauthnCredentialsPayments).where(eq(webauthnCredentialsPayments.userId, a.userId));
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["ASSERTION_INVALID"]);
  });

  it("refuses when the user froze after approval", async () => {
    const a = await approvedButNotExecuted();
    await getDb().update(users).set({ frozenAt: clock.now() }).where(eq(users.id, a.userId));
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["REFUSE_FROZEN"]);
  });

  it("refuses when the payee account changed after signing", async () => {
    const a = await approvedButNotExecuted();
    await getDb().update(payees).set({ accountHash: "changed" }).where(eq(payees.id, a.payee.id));
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["REFUSE_UNVERIFIED_PAYEE"]);
  });

  it("enforces its own daily cap per user in the home currency, summed across currencies (I5, X2)", async () => {
    setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "150000000" }); // ₸1.5M
    try {
      // €2,400 ≈ ₸1.344M (fallback rate). Both orders are approved before either executes, so rules saw no usage
      // and only payments' own cap stands between them.
      const a = await approvedButNotExecuted();
      const landlord = await addPayee(a.userId, { name: "Landlord in Budapest", kind: "LANDLORD", currency: "HUF" });
      const r2 = await proposeOrder({ userId: a.userId, createdBy: "USER", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent" }); // ≈ ₸259,200
      const v2 = await getOrderView(a.userId, r2.proposalId);
      registerExecutor(null);
      const second = await approveOrder(a.userId, r2.proposalId, a.auth.assert(v2.orderHash));
      offlineEnvironment();
      expect((await executeApproval(a.approvalId)).status).toBe("PROCESSING");
      // Different currency (HUF after EUR): the day's total in KZT is over the cap.
      expect((await executeApproval(second.approvalId)).reasonCodes).toEqual(["PAYMENTS_DAILY_CAP"]);
      // The nonce of the refused order was not consumed (the cap refusal rolls the nonce insert back).
      expect(await getDb().select().from(usedNonces)).toHaveLength(1);
    } finally {
      setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: "200000000" });
    }
  });

  it("screens bank transfers itself (I9) even if rules were bypassed", async () => {
    const a = await approvedButNotExecuted();
    setSanctionsListForTests([{ id: "X1", name: "University in Budapest", aliases: [] }]);
    expect((await executeApproval(a.approvalId)).reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
  });

  it("T1: re-checks mandate scope and the stored mandate assertion", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Landlord in Budapest" });
    await signBaseRules(userId, auth);
    const core = await addActiveMandate(userId, auth, { payeeIds: [payee.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 30_000_000 });
    const [rent, rent2] = [await addObligation(userId, payee.id), await addObligation(userId, payee.id)];
    const first = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: payee.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: rent.id });
    expect(first.decision).toBe("AUTO");
    // Period usage now 18M of 30M: a second 18M bill is outside the mandate → rules ASK, never AUTO.
    const second = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: payee.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent again", obligationId: rent2.id });
    expect(second.decision).toBe("ASK");
    expect(second.reasonCodes).toContain("MANDATE_OUT_OF_SCOPE");
    expect(core.mandateId).toBeTruthy();
  });

  it("T1: a mandate whose stored fields were widened fails the signature check", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Landlord in Budapest" });
    await signBaseRules(userId, auth);
    const core = await addActiveMandate(userId, auth, { payeeIds: [payee.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
    const { mandates } = await import("../../src/db/schema.ts");
    await getDb().update(mandates).set({ maxPerPaymentMinor: 99_000_000, maxPerPeriodMinor: 99_000_000 }).where(eq(mandates.id, core.mandateId));
    const bill = await addObligation(userId, payee.id, { amountMinor: 50_000_000 });
    const r = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: payee.id, amountMinor: 50_000_000, currency: "HUF", purpose: "Rent", obligationId: bill.id });
    // Rules matched the (tampered) row, but payments recomputes mandateHash and refuses.
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toContain("BAD_SIGNATURE");
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("T1 small-auto requires the passkey-signed base rules and their limit", async () => {
    const { userId, auth } = await createUserWithPasskey({ moneyMode: "CAPPED_WALLET" });
    const payee = await addPayee(userId, { name: "Corner Shop", kind: "MERCHANT", currency: "KZT" });
    // Seed history so newMerchant is 0 and risk stays low.
    await signBaseRules(userId, auth);
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: 500_000, currency: "KZT", purpose: "Snacks", rail: "BANK_TRANSFER" });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["SMALL_AUTO"]);
    expect((await getDb().select().from(payments))[0]?.status).toBe("PROCESSING");
  });

  it("orderHash of the stored order equals the signed approval hash", async () => {
    const a = await approvedButNotExecuted();
    const p = (await getDb().select().from(proposals).where(eq(proposals.id, a.proposalId)))[0]!;
    expect(orderHash(p.canonicalOrder!)).toBe(a.orderHash);
  });
});
