/*
 * (added 2026-10-19) Judge build: what a reviewer's copy shows without the admin clock.
 * - The copy's mandate-covered rent falls due inside the scheduler's window, so the scheduler pays it under the mandate
 *   without a prompt; POST /demo/run-due-payments runs that pass now, for the caller's own account only, at the Clock's
 *   date (never moved). The agent-side rule agrees: a mandate bill outside the window asks (MANDATE_NOT_DUE_YET).
 * - The copy starts with this month's money from home in its own wallet and a simulated 6-month history (bills paid on
 *   time, monthly money in) that the credit record and the agent's money history read.
 * - "Parents send money" is capped per account per day.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, obligations, payees, payments, profiles } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { mintAccessTokenForTests } from "../../src/modules/auth/session.ts";
import { addMs, clock, DAY_MS, isoDate } from "../../src/modules/clock/index.ts";
import { MONEY_FROM_HOME_DAILY_MAX } from "../../src/modules/demo/judgeCopy.ts";
import { loadSeedData, seedDatabase, type SeedData } from "../../src/modules/demo/seed.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { mockWorld } from "../../src/modules/rails/http.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { DUE_WINDOW_DAYS } from "../../src/modules/scheduler/window.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;
let seed: SeedData;

beforeAll(async () => {
  await ensureIntelTables(t.db());
  mw = await startMockWorld();
  seed = await loadSeedData();
});

afterAll(async () => {
  await mw.close();
});

beforeEach(async () => {
  await seedDatabase(getDb(), seed, { reset: true, personas: true });
});

afterEach(() => {
  resetEnvCache();
  clock.setOffsetInMemoryForTests(0);
});

const judgeEnv = () => setEnvForTests({ DEMO_ENABLED: "true", JUDGE_MODE: "true" });

async function login() {
  const res = await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native", demoClaim: true } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { user: { id: string }; tokens: { accessToken: string } };
  return { id: body.user.id, h: { authorization: `Bearer ${body.tokens.accessToken}` } };
}

async function rentOf(userId: string) {
  return (
    await getDb()
      .select({ o: obligations })
      .from(obligations)
      .innerJoin(payees, eq(payees.id, obligations.payeeId))
      .where(and(eq(obligations.userId, userId), eq(payees.kind, "LANDLORD")))
  )[0]!.o;
}

const entriesOf = async (type: string, userId: string) =>
  (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, type))).filter((e) => (e.payload as { userId?: string }).userId === userId);

describe("judge copy: the scheduler's autopay inside the mandate", () => {
  it("the copy's rent is due inside the window; run-due-payments pays it under the mandate, no prompt, own account only", async () => {
    judgeEnv();
    const a = await login();
    const b = await login();
    const today = isoDate(clock.now());
    const rent = await rentOf(a.id);
    expect(rent.dueDate).toBe(isoDate(addMs(clock.now(), (DUE_WINDOW_DAYS - 1) * DAY_MS)));
    expect(await entriesOf("OBLIGATION_RESCHEDULED", a.id)).toHaveLength(1);

    const res = await app().inject({ method: "POST", url: "/api/demo/run-due-payments", headers: a.h, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { today: string; dueBy: string; results: { obligationId: string; outcome: string; decision: string | null; reasonCodes: string[]; paymentStatus: string | null }[] };
    expect(body.today).toBe(today);
    const paid = body.results.find((r) => r.obligationId === rent.id)!;
    expect(paid).toMatchObject({ outcome: "PROPOSED", decision: "AUTO", reasonCodes: ["MANDATE_MATCH"] });
    expect(paid.paymentStatus).not.toBeNull();
    // Only bills inside the window, only this user's.
    const own = new Set((await getDb().select({ id: obligations.id }).from(obligations).where(eq(obligations.userId, a.id))).map((o) => o.id));
    for (const r of body.results) expect(own.has(r.obligationId)).toBe(true);
    expect(await getDb().select().from(payments).where(eq(payments.userId, a.id))).toHaveLength(1);
    expect(await getDb().select().from(payments).where(eq(payments.userId, b.id))).toHaveLength(0);
    // The shared clock did not move.
    expect(isoDate(clock.now())).toBe(today);

    // Again: already paid, the monthly rent rolls to next month; nothing is paid twice.
    const again = (await app().inject({ method: "POST", url: "/api/demo/run-due-payments", headers: a.h, payload: {} })).json() as typeof body;
    expect(again.results.find((r) => r.obligationId === rent.id)?.outcome).toBe("PAID");
    expect((await rentOf(a.id)).dueDate > rent.dueDate).toBe(true);
    expect(await getDb().select().from(payments).where(eq(payments.userId, a.id))).toHaveLength(1);
  });

  it("the agent and the scheduler agree: the same rent outside the window asks (MANDATE_NOT_DUE_YET)", async () => {
    judgeEnv();
    const a = await login();
    const rent = await rentOf(a.id);
    const later = isoDate(addMs(clock.now(), 13 * DAY_MS));
    await getDb().update(obligations).set({ dueDate: later }).where(eq(obligations.id, rent.id));
    const r = await proposeOrder({ userId: a.id, createdBy: "AGENT", payeeId: rent.payeeId, amountMinor: rent.amountMinor, currency: rent.currency, purpose: "Rent", obligationId: rent.id });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_NOT_DUE_YET");
    // The scheduler pass does not touch it either (not due).
    const run = (await app().inject({ method: "POST", url: "/api/demo/run-due-payments", headers: a.h, payload: {} })).json() as { results: { obligationId: string }[] };
    expect(run.results.map((x) => x.obligationId)).not.toContain(rent.id);
  });

  it("is a demo action for the caller's own account: not for plain sessions outside the judge build", async () => {
    setEnvForTests({ DEMO_ENABLED: "true" });
    const plain = await app().inject({ method: "POST", url: "/api/demo/run-due-payments", headers: { authorization: `Bearer ${await mintAccessTokenForTests(seed.user.id)}` }, payload: {} });
    expect(plain.statusCode).toBe(403);
    expect(plain.json().code).toBe("NOT_DEMO_SESSION");
    expect((await app().inject({ method: "POST", url: "/api/demo/run-due-payments", payload: {} })).statusCode).toBe(401);
  });
});

describe("judge copy: money and history from the start", () => {
  it("starts with this month's money from home and a simulated 6-month history", async () => {
    judgeEnv();
    const a = await login();
    const profile = (await getDb().select().from(profiles).where(eq(profiles.userId, a.id)))[0]!;
    const balances = await mockWorld<{ currency: string; amount: { valueMinor: number } }[]>("GET", `/v4/profiles/${profile.bankProfileId}/balances`);
    expect(balances.find((x) => x.currency === "KZT")!.amount.valueMinor).toBe(190_000_000);
    // The bank's remittance notice reaches the API: a TRIGGER_REMITTANCE for this user (an income month).
    await deliverWebhooks(mw, app());
    expect(await entriesOf("TRIGGER_REMITTANCE", a.id)).toHaveLength(1);

    const [h] = await entriesOf("ACCOUNT_HISTORY_IMPORTED", a.id);
    const history = h!.payload as { simulated: boolean; openedOn: string; bills: { category: string; period: string; paidOn: string }[]; incomes: unknown[] };
    expect(history.simulated).toBe(true);
    expect(history.bills.filter((b) => b.category === "rent")).toHaveLength(6);
    expect(history.bills.filter((b) => b.category === "insurance").length).toBeGreaterThanOrEqual(1);
    for (const b of history.bills) expect(b.paidOn < b.period).toBe(true);
    expect(history.incomes.length).toBeGreaterThanOrEqual(6);
    expect(history.openedOn < history.bills[0]!.period).toBe(true);
    // The agent's money history (get_money_history) is filled from it.
    expect(profile.moneyHistory?.incomes.length).toBeGreaterThan(0);
    expect((await ledger.verify()).ok).toBe(true);

    // The credit record: months of bills paid on time and money received, from an account opened before them.
    const today = isoDate(clock.now());
    const exp = await app().inject({ method: "POST", url: "/api/credit-record/export", headers: a.h, payload: { from: "2000-01-01", to: today, items: ["BILLS", "INCOME", "PAYMENTS"] } });
    expect(exp.statusCode, exp.body).toBe(200);
    const v = (await app().inject({ method: "GET", url: `/api/public/verify/${exp.json().verifyId}` })).json();
    expect(v.accountOpenedOn).toBe(history.openedOn);
    expect(v.summary.billsTotal).toBeGreaterThanOrEqual(7);
    expect(v.summary.billsPaidOnTime).toBe(v.summary.billsTotal);
    expect(v.summary.incomeMonths).toBeGreaterThanOrEqual(6);
    expect(v.summary.paymentsOnTimePct).toBe(100);
    expect(v.importedHistory).toMatchObject({ simulated: true });
  });

  it("caps 'Parents send money' per account per day", async () => {
    judgeEnv();
    const a = await login();
    for (let i = 0; i < MONEY_FROM_HOME_DAILY_MAX; i++) {
      const ok = await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: a.h, payload: {} });
      expect(ok.statusCode, ok.body).toBe(200);
    }
    const over = await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: a.h, payload: {} });
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe("DEMO_MONEY_DAILY_LIMIT");
    // Another copy has its own allowance; the next day the cap renews.
    const b = await login();
    expect((await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: b.h, payload: {} })).statusCode).toBe(200);
    clock.setOffsetInMemoryForTests(clock.offsetMs() + DAY_MS);
    expect((await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: a.h, payload: {} })).statusCode).toBe(200);
  });
});
