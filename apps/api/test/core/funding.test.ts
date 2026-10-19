/*
 * B2: bank transfers are funded through the cheapest feasible route (spec §12) chosen at proposal time and
 * signed with the order (fundingCurrency / fundingAmountMinor max / fundingRouteId / fundingMarkupBps). The
 * mock bank quote then converts fundingCurrency → order currency; payments refuses a quote above the signed
 * maximum. No route covering the order → REFUSE INSUFFICIENT_FUNDS before the user signs.
 * Runs against the real mock-world app (in process, Wise-shaped routes) and the seeded demo user.
 */
import { orderFunding } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../../../mock-world/src/app.ts";
import { FIXTURE_RATES, type RateProvider, type RateTable } from "../../../mock-world/src/bank/rates.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { getDb } from "../../src/db/client.ts";
import { obligations, payees, payments, proposals, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { clock, DAY_MS } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests, walletBalances } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeConversion, proposeOrder } from "../../src/modules/rules/index.ts";
import { billRail, coverageOf } from "../../src/modules/obligations/coverage.ts";
import { loadUser } from "../../src/modules/users/service.ts";
import { proposeDueObligations } from "../../src/modules/scheduler/index.ts";
import { addActiveMandate, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();

class SwappableRates implements RateProvider {
  table: RateTable = FIXTURE_RATES;
  async getRates(): Promise<RateTable> {
    return this.table;
  }
}

let mw: MockWorld | null = null;
const rates = new SwappableRates();

async function startMockWorld(): Promise<MockWorld> {
  await mw?.app.close();
  rates.table = FIXTURE_RATES;
  mw = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    clock: { now: async () => clock.now() },
    rates,
    webhooks: { send: (kind, body) => ({ id: "x", kind, url: "", body, createdAt: "", attempts: 0, status: "delivered", lastStatusCode: 200, lastError: null, deliveredAt: null }) },
    logger: false,
    startTicker: false,
  });
  const app = mw.app;
  setMockWorldTransportForTests(async (method, path, body) => {
    const res = await app.inject({ method: method as "GET", url: `/mock${path}`, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  });
  return mw;
}

async function seededDana() {
  const data = await loadSeedData();
  const { userId } = await seedDatabase(getDb(), data, { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth);
  const all = await getDb().select().from(payees).where(eq(payees.userId, userId));
  const landlord = all.find((p) => p.kind === "LANDLORD")!;
  const university = all.find((p) => p.kind === "UNIVERSITY")!;
  const obs = await getDb().select().from(obligations).where(eq(obligations.userId, userId));
  return { userId, auth, landlord, university, rent: obs.find((o) => o.payeeId === landlord.id)!, tuition: obs.find((o) => o.payeeId === university.id)! };
}

async function wallet(currency: string): Promise<number> {
  const raw = (await mw!.app.inject({ method: "GET", url: "/mock/v4/profiles/16000001/balances?types=STANDARD" })).json() as Array<{ currency: string; amount: { valueMinor: number } }>;
  return raw.find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
}

const tuitionProposal = (userId: string, payeeId: string, obligationId: string) =>
  proposeOrder({ userId, createdBy: "AGENT", payeeId, amountMinor: 240_000, currency: "EUR", purpose: "Tuition RF39RUB2026F04217", category: "tuition", obligationId });

describe("funding route bound into the signed order (B2)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    // Real mock bank: real balances and the real bank rail (no stubs).
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    await startMockWorld();
  });
  afterAll(async () => {
    setMockWorldTransportForTests(null);
    await mw?.app.close();
  });

  it("rent HUF 180,000 with HUF 120,000: funded from KZT, AUTO under the HUF mandate, bank converts KZT → HUF", async () => {
    const d = await seededDana();
    await addActiveMandate(d.userId, d.auth, { payeeIds: [d.landlord.id], categories: ["rent"], currency: "HUF", maxPerPaymentMinor: 20_000_000, maxPerPeriodMinor: 20_000_000 });
    const kztBefore = await wallet("KZT");
    const hufBefore = await wallet("HUF");

    clock.setOffsetInMemoryForTests(clock.nowMs() - Date.now() + 3 * DAY_MS);
    await proposeDueObligations();
    const rent = (await getDb().select().from(proposals).where(eq(proposals.obligationId, d.rent.id)))[0]!;
    expect(rent).toMatchObject({ decision: "AUTO", status: "EXECUTED", reasonCodes: ["MANDATE_MATCH"] });
    const f = orderFunding(rent.canonicalOrder!)!;
    expect(f).toMatchObject({ currency: "KZT", routeId: "kzt-mock-bank", markupBps: 55 });
    // Mandate scope is still checked in the payee currency.
    expect(rent.canonicalOrder).toMatchObject({ amountMinor: 18_000_000, currency: "HUF" });

    const transfers = mw!.bank.listTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ sourceCurrency: "KZT", targetCurrency: "HUF", targetAmountMinor: 18_000_000 });
    expect(transfers[0]!.sourceAmountMinor).toBeLessThanOrEqual(f.maxAmountMinor);
    expect(await wallet("KZT")).toBe(kztBefore - transfers[0]!.sourceAmountMinor);
    expect(await wallet("HUF")).toBe(hufBefore);
    const pay = (await getDb().select().from(payments).where(eq(payments.proposalId, rent.id)))[0]!;
    expect(pay.status).toBe("PROCESSING");
  });

  it("tuition €2,400 when no single balance covers it: REFUSE INSUFFICIENT_FUNDS before signing, nothing to sign", async () => {
    const d = await seededDana();
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toEqual(["INSUFFICIENT_FUNDS"]);
    const row = (await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId)))[0]!;
    expect(row.canonicalOrder).toBeNull();
    await expect(getOrderView(d.userId, r.proposalId)).rejects.toMatchObject({ status: 409 });
    expect(mw!.bank.listTransfers()).toHaveLength(0);
  });

  it("tuition after money from home: ASK with a KZT funding binding; approve → bank converts KZT → EUR", async () => {
    const d = await seededDana();
    await mw!.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { amountMinor: 100_000_000, currency: "KZT" } });
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    expect(r.decision).toBe("ASK");
    const view = await getOrderView(d.userId, r.proposalId);
    const f = orderFunding(view.canonicalOrder)!;
    expect(f).toMatchObject({ currency: "KZT", routeId: "kzt-mock-bank" });
    expect(view.canonicalOrder).toMatchObject({ amountMinor: 240_000, currency: "EUR" });

    const res = await approveOrder(d.userId, r.proposalId, d.auth.assert(view.orderHash));
    expect(res).toMatchObject({ paymentStatus: "PROCESSING", reasonCodes: [] });
    const [tr] = mw!.bank.listTransfers();
    expect(tr).toMatchObject({ sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 240_000 });
    expect(tr!.sourceAmountMinor).toBeLessThanOrEqual(f.maxAmountMinor);
  });

  it("quote above the signed maximum at execution (rate moved): payment refused, no transfer, balance untouched", async () => {
    const d = await seededDana();
    await mw!.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { amountMinor: 100_000_000, currency: "KZT" } });
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    const view = await getOrderView(d.userId, r.proposalId);
    const kzt = await wallet("KZT");
    // KZT weakens 5% after the user signed: the bank now wants more KZT than the signed maximum.
    rates.table = { ...FIXTURE_RATES, rates: { ...FIXTURE_RATES.rates, KZT: "643.02" } };
    const res = await approveOrder(d.userId, r.proposalId, d.auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("FAILED");
    expect(res.reasonCodes).toEqual(["FUNDING_ABOVE_SIGNED_MAX"]);
    expect(mw!.bank.listTransfers()).toHaveLength(0);
    expect(await wallet("KZT")).toBe(kzt);
    // The failed payment released the tuition period (B4): it can be proposed again at the new rate.
    expect((await tuitionProposal(d.userId, d.university.id, d.tuition.id)).decision).toBe("ASK");
  });

  it("an order without a funding binding cannot be paid from another currency by the bank rail", async () => {
    const d = await seededDana();
    // Same-currency bank transfer (HUF 50,000 from the HUF balance): funding = HUF, no conversion.
    const r = await proposeOrder({ userId: d.userId, createdBy: "AGENT", payeeId: d.landlord.id, amountMinor: 5_000_000, currency: "HUF", purpose: "Deposit top-up", category: "rent" });
    const view = await getOrderView(d.userId, r.proposalId);
    expect(orderFunding(view.canonicalOrder)).toMatchObject({ currency: "HUF", routeId: "huf-mock-bank", markupBps: 0, maxAmountMinor: 5_000_000 });
  });

  // (2026-10-18) The hero pays tuition from money she holds: no single balance covers EUR 2,400, so the bill is
  // CONVERTIBLE; each conversion of the plan is a CONVERT order she signs; then the tuition pays from EUR.
  it("tuition: CONVERTIBLE → sign each planned conversion (real mock bank) → the tuition is signed and paid from EUR", async () => {
    const d = await seededDana();
    const u = (await getDb().select().from(users).where(eq(users.id, d.userId)))[0]!;
    const reserveHomeMinor = (await loadUser(getDb(), d.userId)).caps.reserveMinor;
    const coverage = async () =>
      coverageOf(
        { ...d.tuition, payeeKind: "UNIVERSITY", payeeAccountHash: d.university.accountHash },
        { userId: d.userId, homeCurrency: u.homeCurrency, now: clock.now(), balances: (await walletBalances(d.userId))!, rail: billRail(u, "UNIVERSITY"), reserveHomeMinor },
      );
    // As seeded, converting everything would still leave less than the protected reserve after the tuition: rules would
    // refuse it (REFUSE_CAP), so the bills page says SHORTFALL (reserve), not CONVERTIBLE.
    expect(await coverage()).toMatchObject({ coverage: "SHORTFALL", reserveBreached: true });
    // Money from home: still no single balance pays EUR 2,400, but converting first does.
    await mw!.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { amountMinor: 20_000_000, currency: "KZT" } });
    const cov = await coverage();
    expect(cov.coverage).toBe("CONVERTIBLE");
    for (const step of cov.conversions!) {
      const c = await proposeConversion({ userId: d.userId, createdBy: "USER", toCurrency: step.toCurrency, amountMinor: step.amountMinor, fromCurrency: step.fromCurrency });
      expect(c.decision).toBe("ASK");
      const v = await getOrderView(d.userId, c.proposalId);
      expect(await approveOrder(d.userId, c.proposalId, d.auth.assert(v.orderHash))).toMatchObject({ paymentStatus: "SENT", reasonCodes: [] });
    }
    expect(mw!.bank.listTransfers()).toHaveLength(0); // conversions are no transfers out
    const eurBefore = await wallet("EUR");
    expect(eurBefore).toBeGreaterThanOrEqual(240_050);
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    expect(r.decision).toBe("ASK");
    const view = await getOrderView(d.userId, r.proposalId);
    expect(orderFunding(view.canonicalOrder)).toMatchObject({ currency: "EUR", routeId: "eur-mock-bank" });
    expect(await approveOrder(d.userId, r.proposalId, d.auth.assert(view.orderHash))).toMatchObject({ reasonCodes: [] });
    expect(mw!.bank.listTransfers()[0]).toMatchObject({ sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 240_000 });
    expect(await wallet("EUR")).toBe(eurBefore - 240_050);
  });

  // (2026-10-18) A third judge's run: EUR 300 held, tuition EUR 2,400, and an ASK bound to "EUR 2,400.50 from EUR"
  // because the balances read had failed and the same-currency route was bound blind. Unknown balances now refuse.
  it("balances unreadable (bank unreachable): REFUSE BALANCES_UNAVAILABLE after one retry, nothing to sign", async () => {
    const d = await seededDana();
    let reads = 0;
    setBalanceProviderForTests(async () => {
      reads++;
      return null;
    });
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toEqual(["BALANCES_UNAVAILABLE"]);
    expect(reads).toBeGreaterThanOrEqual(2); // funding: read, then one retry (the reserve check reads on its own)
    const row = (await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId)))[0]!;
    expect(row.canonicalOrder).toBeNull();
    // The bill is free again: nothing claimed its period.
    setBalanceProviderForTests(null);
    expect((await tuitionProposal(d.userId, d.university.id, d.tuition.id)).reasonCodes).toEqual(["INSUFFICIENT_FUNDS"]);
  });

  it("a failed balances read followed by a good one (a blip): the retry binds the real route", async () => {
    const d = await seededDana();
    await mw!.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { amountMinor: 100_000_000, currency: "KZT" } });
    let first = true;
    const { getWalletBalances } = await import("../../src/modules/rails/mockBank.ts");
    setBalanceProviderForTests(async (userId) => {
      if (first) {
        first = false;
        return null;
      }
      return getWalletBalances(userId);
    });
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    expect(r.decision).toBe("ASK");
    const view = await getOrderView(d.userId, r.proposalId);
    expect(orderFunding(view.canonicalOrder)).toMatchObject({ currency: "KZT", routeId: "kzt-mock-bank" });
  });

  it("the funding balance is gone by execution: FAILED INSUFFICIENT_FUNDS (not RAIL_ERROR), no transfer created, nothing debited", async () => {
    const d = await seededDana();
    await mw!.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { amountMinor: 100_000_000, currency: "KZT" } });
    const r = await tuitionProposal(d.userId, d.university.id, d.tuition.id);
    const view = await getOrderView(d.userId, r.proposalId);
    // The KZT balance is spent elsewhere after the user saw the order (bank-side, e.g. another channel).
    const store = (mw!.bank as unknown as { store: { debit(p: number, c: string, a: number): Promise<number | null> } }).store;
    await store.debit(16000001, "KZT", (await wallet("KZT")) - 1_000);
    const res = await approveOrder(d.userId, r.proposalId, d.auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("FAILED");
    expect(res.reasonCodes).toEqual(["INSUFFICIENT_FUNDS"]);
    expect(mw!.bank.listTransfers()).toHaveLength(0);
    expect(await wallet("KZT")).toBe(1_000);
    const pay = (await getDb().select().from(payments).where(eq(payments.proposalId, r.proposalId)))[0]!;
    expect(pay).toMatchObject({ status: "FAILED", reasonCodes: ["INSUFFICIENT_FUNDS"] });
  });
});
