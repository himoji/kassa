/*
 * B4: an obligation period is paid at most once. Settlement record per (obligationId, period) with a unique
 * key; the scheduler skips a period that is pending or paid, and rules REFUSE a second proposal for it
 * (DUPLICATE_OBLIGATION_PAYMENT). A rejected order or a failed payment releases the period.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { obligations, obligationSettlements, payments, proposals } from "../../src/db/schema.ts";
import { clock, DAY_MS, isoDate } from "../../src/modules/clock/index.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { buildTools } from "../../src/modules/agent/tools.ts";
import { updatePaymentStatus } from "../../src/modules/payments/status.ts";
import { approveOrder, getOrderView, proposeOrder, rejectOrder } from "../../src/modules/rules/index.ts";
import { proposeDueObligations } from "../../src/modules/scheduler/index.ts";
import { addActiveMandate, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

async function setup() {
  const { userId, auth } = await createUserWithPasskey();
  await signBaseRules(userId, auth);
  const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
  const today = isoDate(clock.now());
  const ob = (
    await getDb()
      .insert(obligations)
      .values({ userId, payeeId: uni.id, amountMinor: 240_000, currency: "EUR", dueDate: addDays(today, 4), recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" })
      .returning()
  )[0]!;
  return { userId, auth, uni, ob };
}

/** What the agent's propose_order sent before the fix: the obligation id, no due date. */
const agentTuition = (userId: string, payeeId: string, obligationId: string) =>
  proposeOrder({ userId, createdBy: "AGENT", payeeId, amountMinor: 240_000, currency: "EUR", purpose: "Tuition", category: "tuition", obligationId });

describe("obligation settlement (B4)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("tuition paid by the agent is not proposed again by the scheduler after +3 days", async () => {
    const { userId, auth, uni, ob } = await setup();
    const r = await agentTuition(userId, uni.id, ob.id);
    expect(r.decision).toBe("ASK");
    const view = await getOrderView(userId, r.proposalId);
    expect((await approveOrder(userId, r.proposalId, auth.assert(view.orderHash))).paymentStatus).toBe("PROCESSING");

    clock.setOffsetInMemoryForTests(3 * DAY_MS);
    expect(await proposeDueObligations()).toBe(0);
    const tuition = await getDb().select().from(proposals).where(eq(proposals.obligationId, ob.id));
    expect(tuition).toHaveLength(1);
    expect(await getDb().select().from(payments)).toHaveLength(1);
    const s = await getDb().select().from(obligationSettlements).where(eq(obligationSettlements.obligationId, ob.id));
    expect(s).toMatchObject([{ period: ob.dueDate, proposalId: r.proposalId, status: "PAID" }]);
  });

  it("a second proposal while the first is pending approval → REFUSE DUPLICATE_OBLIGATION_PAYMENT; scheduler skips", async () => {
    const { userId, uni, ob } = await setup();
    const first = await agentTuition(userId, uni.id, ob.id);
    expect(first.decision).toBe("ASK");
    const second = await agentTuition(userId, uni.id, ob.id);
    expect(second.decision).toBe("REFUSE");
    expect(second.reasonCodes).toEqual(["DUPLICATE_OBLIGATION_PAYMENT"]);
    clock.setOffsetInMemoryForTests(3 * DAY_MS);
    expect(await proposeDueObligations()).toBe(0);
    const live = await getDb()
      .select()
      .from(proposals)
      .where(and(eq(proposals.obligationId, ob.id), eq(proposals.status, "PENDING_APPROVAL")));
    expect(live).toHaveLength(1);
  });

  it("concurrent proposals for the same period: the unique key lets exactly one through", async () => {
    const { userId, uni, ob } = await setup();
    const rs = await Promise.all([agentTuition(userId, uni.id, ob.id), agentTuition(userId, uni.id, ob.id), agentTuition(userId, uni.id, ob.id)]);
    expect(rs.filter((r) => r.decision === "ASK")).toHaveLength(1);
    expect(rs.filter((r) => r.decision === "REFUSE" && r.reasonCodes.includes("DUPLICATE_OBLIGATION_PAYMENT"))).toHaveLength(2);
    expect(await getDb().select().from(obligationSettlements)).toHaveLength(1);
    // The losers' rolled-back transactions left no ledger gap.
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("a rejected order releases the period: the bill can be proposed again", async () => {
    const { userId, uni, ob } = await setup();
    const first = await agentTuition(userId, uni.id, ob.id);
    await rejectOrder(userId, first.proposalId);
    expect(await getDb().select().from(obligationSettlements)).toHaveLength(0);
    expect((await agentTuition(userId, uni.id, ob.id)).decision).toBe("ASK");
  });

  it("a payment that later fails releases the period", async () => {
    const { userId, auth, uni, ob } = await setup();
    const r = await agentTuition(userId, uni.id, ob.id);
    const view = await getOrderView(userId, r.proposalId);
    const res = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    expect(await updatePaymentStatus(res.paymentId!, "FAILED", { source: "test" })).toBe(true);
    expect(await getDb().select().from(obligationSettlements)).toHaveLength(0);
    expect((await agentTuition(userId, uni.id, ob.id)).decision).toBe("ASK");
  });

  it("rent paid by the scheduler under the mandate: an agent proposal for the same month is refused", async () => {
    const { userId, auth } = await createUserWithPasskey();
    await signBaseRules(userId, auth);
    const landlord = await addPayee(userId, { name: "Landlord in Budapest" });
    await addActiveMandate(userId, auth, { payeeIds: [landlord.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
    const ob = (
      await getDb()
        .insert(obligations)
        .values({ userId, payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", dueDate: addDays(isoDate(clock.now()), 2), recurrence: "MONTHLY", reference: null, category: "rent" })
        .returning()
    )[0]!;
    expect(await proposeDueObligations()).toBe(1);
    const again = await proposeOrder({ userId, createdBy: "AGENT", payeeId: landlord.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent", category: "rent", obligationId: ob.id });
    expect(again).toMatchObject({ decision: "REFUSE", reasonCodes: ["DUPLICATE_OBLIGATION_PAYMENT"] });
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });

  it("agent tool after the due date: a paid bill is still recognised (past-due obligation linked) → DUPLICATE", async () => {
    const { userId, auth, uni, ob } = await setup();
    const r = await agentTuition(userId, uni.id, ob.id);
    const view = await getOrderView(userId, r.proposalId);
    await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    clock.setOffsetInMemoryForTests(6 * DAY_MS); // two days past the due date

    const redactor = new Redactor();
    const tools = buildTools({ ports: dbPorts(userId, randomUUID()), redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] });
    const payeeRef = redactor.placeholderFor("PAYEE", uni.id);
    const run = tools.propose_order as unknown as { execute: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<{ decision: string; reasonCodes: string[] }> };
    const out = await run.execute({ payeeRef, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" }, { toolCallId: "t", messages: [] });
    expect(out).toMatchObject({ decision: "REFUSE", reasonCodes: ["DUPLICATE_OBLIGATION_PAYMENT"] });
    expect(await getDb().select().from(payments)).toHaveLength(1);
  });

  it("an obligation of another user is rejected (no settlement claimed on it)", async () => {
    const a = await setup();
    const b = await createUserWithPasskey();
    const bPayee = await addPayee(b.userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
    await expect(agentTuition(b.userId, bPayee.id, a.ob.id)).rejects.toMatchObject({ code: "BAD_OBLIGATION" });
    expect(await getDb().select().from(obligationSettlements)).toHaveLength(0);
  });
});
