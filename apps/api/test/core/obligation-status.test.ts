/*
 * (2026-10-19) A paid bill is not due again. A judge paid rent and tuition, then GET /obligations still listed both as
 * due, GET /forecast took the money a second time on the due date, and the planner's get_obligations told the user
 * tuition was unresolved. Each bill now carries its current period's status (obligations/status.ts): DUE,
 * AWAITING_APPROVAL, IN_FLIGHT, PAID, with the payment and its date; settled periods are left out of coverage and the
 * forecast (a recurring bill continues on its next period), and the planner reads the status and the payments
 * (get_payments).
 */
import { ObligationsResponse } from "@kassa/shared";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { obligations } from "../../src/db/schema.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { buildTools } from "../../src/modules/agent/tools.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { forecastCoverage } from "../../src/modules/fx/index.ts";
import { nextPeriod } from "../../src/modules/obligations/status.ts";
import { updatePaymentStatus } from "../../src/modules/payments/status.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

async function setup() {
  const { userId, auth } = await createUserWithPasskey();
  await signBaseRules(userId, auth);
  const landlord = await addPayee(userId, { name: "Landlord in Budapest", currency: "EUR" });
  const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
  const today = isoDate(clock.now());
  const [rent] = await getDb()
    .insert(obligations)
    .values({ userId, payeeId: landlord.id, amountMinor: 50_000, currency: "EUR", dueDate: addDays(today, 13), recurrence: "MONTHLY", reference: null, category: "rent" })
    .returning();
  const [tuition] = await getDb()
    .insert(obligations)
    .values({ userId, payeeId: uni.id, amountMinor: 240_000, currency: "EUR", dueDate: addDays(today, 10), recurrence: "ONCE", reference: "RF39RUB2026F04217", category: "tuition" })
    .returning();
  return { userId, auth, landlord, uni, rent: rent!, tuition: tuition! };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function pay(s: Setup, o: Setup["rent"], opts: { approve: boolean }) {
  const r = await proposeOrder({ userId: s.userId, createdBy: "AGENT", payeeId: o.payeeId, amountMinor: o.amountMinor, currency: o.currency, purpose: o.category, category: o.category, obligationId: o.id });
  expect(r.decision, JSON.stringify(r)).toBe("ASK");
  if (!opts.approve) return { proposalId: r.proposalId, paymentId: null };
  const view = await getOrderView(s.userId, r.proposalId);
  const a = await approveOrder(s.userId, r.proposalId, s.auth.assert(view.orderHash));
  return { proposalId: r.proposalId, paymentId: a.paymentId };
}

async function list(userId: string) {
  const res = await app().inject({ method: "GET", url: "/api/obligations", headers: await bearer(userId) });
  expect(res.statusCode, res.body).toBe(200);
  return ObligationsResponse.parse(res.json()).obligations;
}

function tool(userId: string, name: string) {
  const redactor = new Redactor();
  const tools = buildTools({ ports: dbPorts(userId, randomUUID()), redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] });
  const run = tools[name] as unknown as { execute: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<Record<string, unknown>> };
  return { redactor, run: (input: unknown = {}) => run.execute(input, { toolCallId: "t", messages: [] }) };
}

describe("bill status per period", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(async () => [{ currency: "EUR", amountMinor: 1_000_000 }]);
  });

  it("GET /obligations: DUE, AWAITING_APPROVAL, IN_FLIGHT, then PAID with the payment and its date", async () => {
    const s = await setup();
    let obs = await list(s.userId);
    expect(obs.map((o) => o.status)).toEqual(["DUE", "DUE"]);

    const rent = await pay(s, s.rent, { approve: false });
    obs = await list(s.userId);
    const waiting = obs.find((o) => o.id === s.rent.id)!;
    expect(waiting).toMatchObject({ status: "AWAITING_APPROVAL", proposalId: rent.proposalId, paymentId: null, coverage: "COVERED" });
    // No money moved: still checked for coverage.
    expect(waiting.bestRoute).not.toBeNull();

    const tu = await pay(s, s.tuition, { approve: true });
    obs = await list(s.userId);
    expect(obs.find((o) => o.id === s.tuition.id)).toMatchObject({ status: "IN_FLIGHT", paymentId: tu.paymentId, paidAt: null, coverage: "COVERED", bestRoute: null });

    expect(await updatePaymentStatus(tu.paymentId!, "SENT", { source: "test" })).toBe(true);
    obs = await list(s.userId);
    const paid = obs.find((o) => o.id === s.tuition.id)!;
    expect(paid).toMatchObject({ status: "PAID", paymentId: tu.paymentId, nextDueDate: null });
    expect(paid.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a recurring bill paid early moves to its next period; a failed payment makes it due again", async () => {
    const s = await setup();
    const rent = await pay(s, s.rent, { approve: true });
    await updatePaymentStatus(rent.paymentId!, "SENT", { source: "test" });
    const r = (await list(s.userId)).find((o) => o.id === s.rent.id)!;
    expect(r).toMatchObject({ status: "PAID", dueDate: s.rent.dueDate, nextDueDate: nextPeriod(s.rent.dueDate, "MONTHLY") });

    const tu = await pay(s, s.tuition, { approve: true });
    await updatePaymentStatus(tu.paymentId!, "FAILED", { source: "test" });
    expect((await list(s.userId)).find((o) => o.id === s.tuition.id)).toMatchObject({ status: "DUE", paymentId: null });
  });

  it("the forecast no longer takes a paid bill's money on its due date (a recurring one is drawn a month later)", async () => {
    const s = await setup();
    const at = (f: Awaited<ReturnType<typeof forecastCoverage>>, date: string) => f.currencies.find((c) => c.currency === "EUR")!.points.find((p) => p.date === date)!.balanceMinor;
    const before = await forecastCoverage(s.userId);
    const dayBefore = addDays(s.tuition.dueDate, -1);
    expect(at(before, dayBefore) - at(before, s.tuition.dueDate)).toBeGreaterThanOrEqual(240_000);
    const rentDrop = (f: typeof before) => at(f, addDays(s.rent.dueDate, -1)) - at(f, s.rent.dueDate);
    expect(rentDrop(before)).toBeGreaterThanOrEqual(50_000);

    const tu = await pay(s, s.tuition, { approve: true });
    await pay(s, s.rent, { approve: true });
    await updatePaymentStatus(tu.paymentId!, "SENT", { source: "test" });
    // Rent still PROCESSING: a bank transfer on its way was debited already, so it is not drawn again either.
    const after = await forecastCoverage(s.userId);
    expect(at(after, dayBefore) - at(after, s.tuition.dueDate)).toBeLessThan(240_000);
    expect(rentDrop(after)).toBeLessThan(50_000);
    const next = nextPeriod(s.rent.dueDate, "MONTHLY")!;
    const horizonEnd = after.currencies[0]!.points.at(-1)!.date;
    if (next <= horizonEnd) expect(at(after, addDays(next, -1)) - at(after, next)).toBeGreaterThanOrEqual(50_000);
  });

  it("get_obligations tells the planner the status; get_payments lists the payments", async () => {
    const s = await setup();
    const tu = await pay(s, s.tuition, { approve: true });
    await updatePaymentStatus(tu.paymentId!, "SENT", { source: "test" });
    const rent = await pay(s, s.rent, { approve: false });

    const ob = tool(s.userId, "get_obligations");
    const out = (await ob.run({})) as { obligations: Array<Record<string, unknown>> };
    const tuition = out.obligations.find((o) => o.obligationId === s.tuition.id)!;
    expect(tuition).toMatchObject({ status: "PAID", paymentId: tu.paymentId, paymentStatus: "SENT" });
    // A settled bill is not offered as one to pay: no coverage, no route.
    expect(tuition.coverage).toBeUndefined();
    const r = out.obligations.find((o) => o.obligationId === s.rent.id)!;
    expect(r).toMatchObject({ status: "AWAITING_APPROVAL", proposalId: rent.proposalId, coverage: "COVERED" });

    const pays = tool(s.userId, "get_payments");
    const p = (await pays.run({ limit: 5 })) as { payments: Array<Record<string, unknown>> };
    expect(p.payments).toHaveLength(2);
    // Newest first.
    expect(p.payments[0]).toMatchObject({ proposalId: rent.proposalId, status: "AWAITING_APPROVAL", approvedBy: null, bill: { obligationId: s.rent.id, period: s.rent.dueDate }, amount: "EUR 500.00" });
    expect(p.payments[1]).toMatchObject({ proposalId: tu.proposalId, status: "SENT", approvedBy: "PASSKEY", paymentId: tu.paymentId, bill: { obligationId: s.tuition.id } });
    expect(p.payments[1]!.deliveredAt).toMatch(/^\d{4}-/);
    // Payees only as placeholders (I11): no names, no accounts.
    expect(String(p.payments[1]!.payeeRef)).toMatch(/^payee_\d+$/);
    expect(JSON.stringify(p)).not.toContain("University in Budapest");
    expect(JSON.stringify(p)).not.toContain(IBAN_UNIVERSITY);
    expect(JSON.stringify(p)).not.toContain("RF39RUB2026F04217");
  });
});
