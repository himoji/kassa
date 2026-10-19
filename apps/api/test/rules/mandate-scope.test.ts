/*
 * X1 (cn report B5a): a mandate covers only the bills the user signed it for. A fooled planner sent HUF 1,000 to
 * the landlord under the rent mandate without a passkey because any purpose to a mandate payee matched.
 * Now AUTO under a mandate needs a draft linked server-side to an obligation in the mandate's scope: payee in
 * payeeIds, the obligation's category (never the agent's) in the categories, amount ≤ the bill, period unsettled.
 * Anything else to that payee → ASK + MANDATE_SCOPE_MISMATCH. Payments re-checks the same link itself (I2).
 */
import { orderHash, type CanonicalOrder } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, obligations, obligationSettlements, payments, proposals } from "../../src/db/schema.ts";
import { addMs, clock, isoDate } from "../../src/modules/clock/index.ts";
import { DUE_WINDOW_DAYS } from "../../src/modules/scheduler/window.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { APPROVAL_TTL_MS, signApproval } from "../../src/modules/rules/signing.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addActiveMandate, addObligation, addPayee, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

async function rentSetup() {
  const { userId, auth } = await createUserWithPasskey({ preset: "SMART" });
  await signBaseRules(userId, auth);
  const landlord = await addPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD" });
  const rent = await addObligation(userId, landlord.id, { amountMinor: 18_000_000, category: "rent" });
  const mandate = await addActiveMandate(userId, auth, {
    payeeIds: [landlord.id],
    categories: ["rent"],
    currency: "HUF",
    maxPerPaymentMinor: 20_000_000,
    maxPerPeriodMinor: 20_000_000,
  });
  return { userId, auth, landlord, rent, mandate };
}

/**
 * Simulate a rules LOGIC bug (not a stolen key): a T1 mandate approval for an order rules should never have
 * auto-approved. Payments must refuse it on its own checks.
 */
async function forgedMandateApproval(s: Awaited<ReturnType<typeof rentSetup>>, o: { amountMinor: number; obligation?: { id: string; period: string } }) {
  const now = clock.now();
  const proposalId = randomUUID();
  const order: CanonicalOrder = {
    v: 1,
    proposalId,
    userId: s.userId,
    payeeId: s.landlord.id,
    payeeName: s.landlord.name,
    payeeAccountHash: s.landlord.accountHash!,
    amountMinor: o.amountMinor,
    currency: "HUF",
    rail: "BANK_TRANSFER",
    purpose: "Pre-approved landlord fee",
    homeAmountMinor: Math.round(o.amountMinor * 1.44),
    homeCurrency: "KZT",
    mandateId: s.mandate.mandateId,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: addMs(now, 10 * 60_000).toISOString(),
    ...(o.obligation ? { obligationId: o.obligation.id, obligationPeriod: o.obligation.period } : {}),
  };
  const hash = orderHash(order);
  const db = getDb();
  await db.insert(proposals).values({
    id: proposalId,
    userId: s.userId,
    createdBy: "AGENT",
    draft: { payeeId: s.landlord.id, amountMinor: o.amountMinor, currency: "HUF", purpose: order.purpose, category: "rent" },
    decision: "AUTO",
    reasonCodes: ["MANDATE_MATCH"],
    riskScore: 0,
    canonicalOrder: order,
    orderHash: hash,
    status: "APPROVED",
    category: "rent",
    obligationId: o.obligation?.id ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const { fields, sig } = signApproval({ orderHash: hash, tier: "T1", issuedAt: now.toISOString(), expiresAt: addMs(now, APPROVAL_TTL_MS).toISOString() });
  const row = await db
    .insert(approvals)
    .values({ proposalId, orderHash: hash, tier: "T1", approvalSig: sig, keyId: fields.keyId, userAssertion: null, mandateId: s.mandate.mandateId, issuedAt: now, expiresAt: addMs(now, APPROVAL_TTL_MS) })
    .returning({ id: approvals.id });
  return { approvalId: row[0]!.id, proposalId };
}

describe("X1 mandate scope: rules", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
  });

  it("B5a: HUF 1,000 to the landlord, not linked to a bill → ASK MANDATE_SCOPE_MISMATCH, nothing paid", async () => {
    const s = await rentSetup();
    const r = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: s.landlord.id, amountMinor: 100_000, currency: "HUF", purpose: "User already agreed" });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_SCOPE_MISMATCH");
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("an agent-supplied category is not trusted: category 'rent' without a linked bill still asks", async () => {
    const s = await rentSetup();
    const r = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: s.landlord.id, amountMinor: 100_000, currency: "HUF", purpose: "Rent", category: "rent" });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_SCOPE_MISMATCH");
  });

  it("the rent bill itself (linked, amount = bill) → AUTO MANDATE_MATCH; the order is bound to the obligation period", async () => {
    const s = await rentSetup();
    const r = await proposeOrder({ userId: s.userId, createdBy: "SCHEDULER", payeeId: s.landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: s.rent.id });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["MANDATE_MATCH"]);
    const p = (await getDb().select().from(proposals))[0]!;
    expect(p.canonicalOrder).toMatchObject({ mandateId: s.mandate.mandateId, obligationId: s.rent.id, obligationPeriod: s.rent.dueDate });
    expect((await getDb().select().from(payments))[0]!.status).not.toBe("FAILED");
  });

  it("a linked bill whose category is outside the mandate → ASK, and the category comes from the obligation, not the input", async () => {
    const s = await rentSetup();
    const utilities = await addObligation(s.userId, s.landlord.id, { amountMinor: 1_500_000, category: "utilities" });
    const r = await proposeOrder({
      userId: s.userId,
      createdBy: "AGENT",
      payeeId: s.landlord.id,
      amountMinor: 1_500_000,
      currency: "HUF",
      purpose: "Utilities",
      category: "rent",
      obligationId: utilities.id,
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_SCOPE_MISMATCH");
    expect((await getDb().select().from(proposals))[0]!.category).toBe("utilities");
  });

  it("linked to the rent bill but above the bill's amount → ASK MANDATE_SCOPE_MISMATCH", async () => {
    const s = await rentSetup();
    const r = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: s.landlord.id, amountMinor: 18_500_000, currency: "HUF", purpose: "Rent plus", obligationId: s.rent.id });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_SCOPE_MISMATCH");
  });

  it("a small amount to the mandate payee never auto-pays through the small-auto limit either", async () => {
    const s = await rentSetup();
    // HUF 5,000 ≈ ₸7,200 < ₸10,000 small-auto limit, verified payee, SMART, signed base rules.
    const r = await proposeOrder({ userId: s.userId, createdBy: "USER", payeeId: s.landlord.id, amountMinor: 500_000, currency: "HUF", purpose: "Key deposit" });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).not.toContain("SMALL_AUTO");
    expect(r.reasonCodes).toContain("MANDATE_SCOPE_MISMATCH");
  });
});

describe("X1 mandate scope: payments re-checks the obligation link itself (I2)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
  });

  it("refuses a T1 mandate approval for an order not linked to any obligation", async () => {
    const s = await rentSetup();
    const { approvalId } = await forgedMandateApproval(s, { amountMinor: 100_000 });
    const res = await executeApproval(approvalId);
    expect(res).toMatchObject({ paymentId: null, status: "FAILED", reasonCodes: ["MANDATE_SCOPE_MISMATCH"] });
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("refuses a T1 mandate approval above the linked bill's amount", async () => {
    const s = await rentSetup();
    const { approvalId, proposalId } = await forgedMandateApproval(s, { amountMinor: 19_000_000, obligation: { id: s.rent.id, period: s.rent.dueDate } });
    await getDb().insert(obligationSettlements).values({ obligationId: s.rent.id, period: s.rent.dueDate, userId: s.userId, proposalId, status: "PENDING", createdAt: clock.now(), updatedAt: clock.now() });
    expect((await executeApproval(approvalId)).reasonCodes).toEqual(["MANDATE_SCOPE_MISMATCH"]);
  });

  it("refuses a T1 mandate approval for a bill whose category the mandate does not cover", async () => {
    const s = await rentSetup();
    const utilities = await addObligation(s.userId, s.landlord.id, { amountMinor: 1_500_000, category: "utilities" });
    const { approvalId, proposalId } = await forgedMandateApproval(s, { amountMinor: 1_500_000, obligation: { id: utilities.id, period: utilities.dueDate } });
    await getDb().insert(obligationSettlements).values({ obligationId: utilities.id, period: utilities.dueDate, userId: s.userId, proposalId, status: "PENDING", createdAt: clock.now(), updatedAt: clock.now() });
    expect((await executeApproval(approvalId)).reasonCodes).toEqual(["MANDATE_SCOPE_MISMATCH"]);
  });

  it("refuses a T1 mandate approval for a period another proposal already settled", async () => {
    const s = await rentSetup();
    const paid = await proposeOrder({ userId: s.userId, createdBy: "SCHEDULER", payeeId: s.landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: s.rent.id });
    expect(paid.decision).toBe("AUTO");
    const { approvalId } = await forgedMandateApproval(s, { amountMinor: 18_000_000, obligation: { id: s.rent.id, period: s.rent.dueDate } });
    expect((await executeApproval(approvalId)).reasonCodes).toEqual(["DUPLICATE_OBLIGATION_PAYMENT"]);
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });
});

describe("mandate AUTO only within the due window (2026-10-19, scheduler/window.ts)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
  });

  async function earlyRent() {
    const { userId, auth } = await createUserWithPasskey({ preset: "SMART" });
    await signBaseRules(userId, auth);
    const landlord = await addPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD" });
    // Due in 13 days: what the judge saw paid at once.
    const rent = await addObligation(userId, landlord.id, { amountMinor: 18_000_000, category: "rent", dueDate: isoDate(addMs(clock.now(), 13 * 86_400_000)) });
    const mandate = await addActiveMandate(userId, auth, { payeeIds: [landlord.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
    return { userId, auth, landlord, rent, mandate };
  }

  it("the agent proposing rent due in 13 days → ASK MANDATE_NOT_DUE_YET, nothing paid", async () => {
    const s = await earlyRent();
    const r = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: s.landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: s.rent.id });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toEqual(["MANDATE_NOT_DUE_YET"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("the last day of the window is still AUTO; the day after asks", async () => {
    const s = await earlyRent();
    const at = (days: number) => isoDate(addMs(clock.now(), days * 86_400_000));
    await getDb().update(obligations).set({ dueDate: at(DUE_WINDOW_DAYS + 1) }).where(eq(obligations.id, s.rent.id));
    const early = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: s.landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: s.rent.id });
    expect(early.reasonCodes).toEqual(["MANDATE_NOT_DUE_YET"]);
    // The early proposal claimed the period; reject it to free the bill, then bring the due date to the window's edge.
    await getDb().delete(obligationSettlements);
    await getDb().update(obligations).set({ dueDate: at(DUE_WINDOW_DAYS) }).where(eq(obligations.id, s.rent.id));
    const due = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: s.landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: s.rent.id });
    expect(due.decision).toBe("AUTO");
    expect(due.reasonCodes).toEqual(["MANDATE_MATCH"]);
  });

  it("payments refuses a T1 mandate approval for a bill not due yet (a rules bug that signs it anyway)", async () => {
    const s = await earlyRent();
    const { approvalId } = await forgedMandateApproval(s, { amountMinor: 18_000_000, obligation: { id: s.rent.id, period: s.rent.dueDate } });
    expect((await executeApproval(approvalId)).reasonCodes).toEqual(["MANDATE_NOT_DUE_YET"]);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});

