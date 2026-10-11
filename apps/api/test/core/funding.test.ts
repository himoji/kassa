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
import { obligations, payees, payments, proposals, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { clock, DAY_MS } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
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
});
