/*
 * (2026-10-18) Caps hold at approval time, not only at proposal time. Two orders that each fit the daily cap are both
 * offered for signing (neither sees the other at proposal time); approving both must not pay past the cap. Rules
 * re-check the caps when an order is approved (T2 passkey or AUTO) under the per-user payments lock, counting live
 * payments and approved orders still in flight. Payments checks a mandate's period maximum under the same lock as its
 * payment insert, so two mandate payments executing at once cannot both pass it.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, ledgerEntries, payments, profiles, proposals } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { toHome } from "../../src/modules/money/fx.ts";
import { executeApproval, registerHomeConverter } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder, registerExecutor } from "../../src/modules/rules/index.ts";
import { DEFAULT_CAPS } from "../../src/modules/users/service.ts";
import { addActiveMandate, addObligation, addPayee, createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

/** A KZT user whose daily cap is ₸1,000,000 (100,000,000 minor), and a verified KZT payee. */
async function userWithDailyCap() {
  const { userId, auth } = await createUserWithPasskey({ preset: "ASK_ME" });
  await getDb()
    .update(profiles)
    .set({ caps: { ...DEFAULT_CAPS, perPaymentMinor: 100_000_000, perDayMinor: 100_000_000, perMonthMinor: 300_000_000 } })
    .where(eq(profiles.userId, userId));
  const payee = await addPayee(userId, { name: "Landlord in Almaty", kind: "LANDLORD", currency: "KZT" });
  return { userId, auth, payee };
}

/** ₸600,000: each fits the ₸1,000,000 daily cap, two do not. */
const sixty = (userId: string, payeeId: string, purpose: string) => proposeOrder({ userId, createdBy: "USER", payeeId, amountMinor: 60_000_000, currency: "KZT", purpose });

describe("caps at approval time (executed + in flight, under the payments lock)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.freezeForTests(null);
  });

  it("two 60s under a 100 daily cap, both pending: the first approval pays, the second is refused REFUSE_CAP and stays pending", async () => {
    const { userId, auth, payee } = await userWithDailyCap();
    const a = await sixty(userId, payee.id, "Rent part 1");
    const b = await sixty(userId, payee.id, "Rent part 2");
    // Proposal time: neither sees the other, both are offered for signing.
    expect([a.decision, b.decision]).toEqual(["ASK", "ASK"]);
    const va = await getOrderView(userId, a.proposalId);
    const vb = await getOrderView(userId, b.proposalId);
    expect((await approveOrder(userId, a.proposalId, auth.assert(va.orderHash))).paymentStatus).toBe("PROCESSING");
    await expect(approveOrder(userId, b.proposalId, auth.assert(vb.orderHash))).rejects.toMatchObject({ status: 409, code: "REFUSE_CAP" });
    expect(await getDb().select().from(payments)).toHaveLength(1);
    const second = (await getDb().select().from(proposals).where(eq(proposals.id, b.proposalId)))[0]!;
    expect(second.status).toBe("PENDING_APPROVAL");
    const denied = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "APPROVAL_DENIED"))).map((e) => e.payload as { proposalId: string; reasonCodes: string[] });
    expect(denied).toContainEqual(expect.objectContaining({ proposalId: b.proposalId, reasonCodes: ["REFUSE_CAP"] }));
  });

  it("an approved order still in flight counts: approving the second before the first executes is refused", async () => {
    const { userId, auth, payee } = await userWithDailyCap();
    const a = await sixty(userId, payee.id, "Rent part 1");
    const b = await sixty(userId, payee.id, "Rent part 2");
    const va = await getOrderView(userId, a.proposalId);
    const vb = await getOrderView(userId, b.proposalId);
    registerExecutor(null); // the first stays APPROVED with no payment row (in flight)
    await approveOrder(userId, a.proposalId, auth.assert(va.orderHash));
    await expect(approveOrder(userId, b.proposalId, auth.assert(vb.orderHash))).rejects.toMatchObject({ code: "REFUSE_CAP" });
    // ...and a new proposal sees it too: refused before signing.
    const c = await sixty(userId, payee.id, "Rent part 3");
    expect(c.decision).toBe("REFUSE");
    expect(c.reasonCodes).toContain("REFUSE_CAP");
  });

  it("two approvals racing: exactly one is approved and paid, the other is refused REFUSE_CAP", async () => {
    const { userId, auth, payee } = await userWithDailyCap();
    const a = await sixty(userId, payee.id, "Rent part 1");
    const b = await sixty(userId, payee.id, "Rent part 2");
    const va = await getOrderView(userId, a.proposalId);
    const vb = await getOrderView(userId, b.proposalId);
    const results = await Promise.allSettled([approveOrder(userId, a.proposalId, auth.assert(va.orderHash)), approveOrder(userId, b.proposalId, auth.assert(vb.orderHash))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "REFUSE_CAP" });
    const paid = await getDb().select().from(payments);
    expect(paid).toHaveLength(1);
    expect(paid.reduce((s, p) => s + p.amountMinor, 0)).toBeLessThanOrEqual(100_000_000);
  });

  it("a lower cap signed after proposal applies at approval: the pending order no longer fits and is refused", async () => {
    const { userId, auth, payee } = await userWithDailyCap();
    const a = await sixty(userId, payee.id, "Rent");
    const va = await getOrderView(userId, a.proposalId);
    // Tightening applies at once (I8); the order was proposed under the old cap.
    await getDb()
      .update(profiles)
      .set({ caps: { ...DEFAULT_CAPS, perPaymentMinor: 50_000_000, perDayMinor: 50_000_000, perMonthMinor: 300_000_000 } })
      .where(eq(profiles.userId, userId));
    await expect(approveOrder(userId, a.proposalId, auth.assert(va.orderHash))).rejects.toMatchObject({ code: "REFUSE_CAP" });
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});

describe("mandate period maximum under the payments lock", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.freezeForTests(null);
  });

  it("two mandate payments approved before either executes: the second to reach the lock sees the first's payment and is refused", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Landlord in Budapest" });
    await addActiveMandate(userId, auth, { payeeIds: [payee.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 30_000_000 });
    const [rent, rent2] = [await addObligation(userId, payee.id), await addObligation(userId, payee.id)];
    registerExecutor(null); // both AUTO approvals stay unexecuted: rules' proposal-time view sees no mandate usage
    const first = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: payee.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", obligationId: rent.id });
    const second = await proposeOrder({ userId, createdBy: "SCHEDULER", payeeId: payee.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent 2", obligationId: rent2.id });
    expect([first.decision, second.decision]).toEqual(["AUTO", "AUTO"]);
    offlineEnvironment();
    const byProposal = new Map((await getDb().select().from(approvals)).map((r) => [r.proposalId, r.id]));
    const [a, b] = [byProposal.get(first.proposalId)!, byProposal.get(second.proposalId)!];
    // Deterministic interleaving: payments converts the order to the home currency after its mandate checks and before
    // its locked transaction. On A's first conversion, B runs to completion (its payment row is inserted) before A goes on.
    let interleaved: Awaited<ReturnType<typeof executeApproval>> | null = null;
    registerHomeConverter(async (amountMinor, currency, homeCurrency, at, rounding) => {
      if (interleaved === null && currency === "HUF") {
        interleaved = { paymentId: null, status: null, reasonCodes: [] };
        interleaved = await executeApproval(b);
      }
      return (await toHome(amountMinor, currency, homeCurrency, at, rounding)).amountMinor;
    });
    const resA = await executeApproval(a);
    expect(interleaved!.paymentId).not.toBeNull(); // B paid first
    expect(resA.paymentId).toBeNull(); // A reached the lock second: 18M + 18M > the 30M period maximum
    expect(resA.reasonCodes).toEqual(["MANDATE_OUT_OF_SCOPE"]);
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });
});
