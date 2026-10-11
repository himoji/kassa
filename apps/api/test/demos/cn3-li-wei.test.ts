/*
 * D-CN3 second seeded persona Li Wei (home CNY, region EU, SMART, capped wallet): seeded only with `personas: true`;
 * his own payee rows (same landlord name, own account; same university account, own reference); CNY → EUR tuition
 * gives a clear three-route comparison; the coverage forecast funds EUR and HUF needs from CNY; tuition is funded
 * from CNY through the cheapest executable route; Dana cannot see his orders (BOLA).
 * Runs against the real mock-world app (in process) and the API app (inject), like funding.test.ts.
 */
import { orderFunding } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../../../mock-world/src/app.ts";
import { FIXTURE_RATES, type RateProvider, type RateTable } from "../../../mock-world/src/bank/rates.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { IDS, LI_WEI_IDS, LI_WEI_MOCK_BANK_PROFILE_ID, LI_WEI_TUITION_REFERENCE } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import {
  budgets,
  cards,
  demoState,
  obligations,
  payees,
  profiles,
  transactions,
  users,
  webauthnCredentialsPayments,
  webauthnCredentialsRules,
} from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { forecastCoverage, getRoutes } from "../../src/modules/fx/index.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();

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
  const mock = mw.app;
  setMockWorldTransportForTests(async (method, path, body) => {
    const res = await mock.inject({ method: method as "GET", url: `/mock${path}`, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  });
  return mw;
}

/** Seeds Dana and Li Wei (`personas: true`). */
async function seedBoth() {
  const data = await loadSeedData();
  return seedDatabase(getDb(), data, { reset: true, personas: true });
}

/** One software passkey in both credential tables, base rules signed in the given home currency. */
async function withPasskey(userId: string, homeCurrency: string): Promise<SoftAuthenticator> {
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth, homeCurrency);
  return auth;
}

/** Li Wei's wallet balance (mock bank profile 16000002) in one currency. */
async function liWallet(currency: string): Promise<number> {
  const raw = (await mw!.app.inject({ method: "GET", url: `/mock/v4/profiles/${LI_WEI_MOCK_BANK_PROFILE_ID}/balances?types=STANDARD` })).json() as Array<{
    currency: string;
    amount: { valueMinor: number };
  }>;
  return raw.find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
}

describe("second persona Li Wei (D-CN3)", () => {
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

  it("seeded only with personas: true; Dana stays the demo user", async () => {
    const data = await loadSeedData();
    await seedDatabase(getDb(), data, { reset: true });
    expect(await getDb().select({ id: users.id }).from(users)).toHaveLength(1);

    const r = await seedBoth();
    const allUsers = await getDb().select().from(users);
    expect(allUsers).toHaveLength(2);
    expect(r.personaUserIds).toEqual([LI_WEI_IDS.user]);

    const [ds] = await getDb().select().from(demoState).where(eq(demoState.id, 1));
    expect(ds?.demoUserId).toBe(IDS.user);

    const [li] = await getDb().select().from(users).where(eq(users.id, LI_WEI_IDS.user));
    expect(li).toMatchObject({ displayName: "Li Wei", homeCurrency: "CNY", region: "EU", preset: "SMART" });

    const [liProfile] = await getDb().select().from(profiles).where(eq(profiles.userId, LI_WEI_IDS.user));
    expect(liProfile!.caps).toMatchObject({ perPaymentMinor: 3_000_000, smallAutoMinor: 10_000, reserveMinor: 200_000 });
    expect(liProfile!.bankProfileId).toBe(16_000_002);
    expect(liProfile!.incomes).toEqual([{ source: "Parents", currency: "CNY", amountMinor: 1_200_000, cadence: "MONTHLY", nextDate: "2026-11-20" }]);
  });

  it("Li's payees are his own rows: same landlord name with his own account, same university account", async () => {
    await seedBoth();
    const danaPayees = await getDb().select().from(payees).where(eq(payees.userId, IDS.user));
    const liPayees = await getDb().select().from(payees).where(eq(payees.userId, LI_WEI_IDS.user));
    expect(liPayees).toHaveLength(2);

    const liLandlord = liPayees.find((p) => p.id === LI_WEI_IDS.payees.landlord)!;
    expect(liLandlord).toMatchObject({ id: LI_WEI_IDS.payees.landlord, name: "Landlord in Budapest", userId: LI_WEI_IDS.user });
    const danaLandlord = danaPayees.find((p) => p.id === IDS.payees.landlord)!;
    expect(danaLandlord.name).toBe(liLandlord.name);
    expect(danaLandlord.id).not.toBe(liLandlord.id);
    expect(danaLandlord.accountHash).not.toBe(liLandlord.accountHash);

    const liUniversity = liPayees.find((p) => p.id === LI_WEI_IDS.payees.university)!;
    const danaUniversity = danaPayees.find((p) => p.id === IDS.payees.university)!;
    expect(liUniversity.accountHash).toBe(danaUniversity.accountHash);
    expect(liUniversity.id).not.toBe(danaUniversity.id);
    expect(liUniversity.userId).not.toBe(danaUniversity.userId);

    const liObligations = await getDb().select().from(obligations).where(eq(obligations.userId, LI_WEI_IDS.user));
    expect(liObligations.find((o) => o.id === LI_WEI_IDS.obligations.tuition)).toMatchObject({
      amountMinor: 320_000,
      currency: "EUR",
      dueDate: "2026-11-10",
      reference: LI_WEI_TUITION_REFERENCE,
    });
    expect(liObligations.find((o) => o.id === LI_WEI_IDS.obligations.rent)).toMatchObject({ amountMinor: 16_500_000, currency: "HUF", dueDate: "2026-11-05" });

    const liBudgets = await getDb().select().from(budgets).where(eq(budgets.userId, LI_WEI_IDS.user));
    expect(liBudgets).toHaveLength(3);
    expect(Object.fromEntries(liBudgets.map((b) => [b.category, b.limitHomeMinor]))).toEqual({ groceries: 150_000, eating_out: 100_000, transport: 30_000 });

    const liCards = await getDb().select().from(cards).where(eq(cards.userId, LI_WEI_IDS.user));
    expect(liCards).toHaveLength(2);
    expect(liCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ billingCurrency: "CNY", last4: "3388", kind: "MULTI" }),
        expect.objectContaining({ billingCurrency: "HUF", last4: "1542" }),
      ]),
    );

    const liTxns = await getDb().select().from(transactions).where(eq(transactions.userId, LI_WEI_IDS.user));
    expect(liTxns).toHaveLength(15);
  });

  it("CNY → EUR tuition: three routes, cheapest first", async () => {
    await seedBoth();
    const r = await getRoutes({ userId: LI_WEI_IDS.user, fromCurrency: "CNY", toCurrency: "EUR", amountMinor: 320_000, dueDate: "2026-11-10" });
    expect(r.homeCurrency).toBe("CNY");
    expect(r.routes.map((x) => [x.routeId, x.costHomeMinor, x.savingsVsWorstHomeMinor])).toEqual([
      ["cny-mock-bank:CNY", 16_280, 38_560],
      ["cny-card:CNY", 39_840, 15_000],
      ["cny-home-bank:CNY", 54_840, 0],
    ]);
  });

  it("without fromCurrency every route is funded from CNY (EUR and HUF cannot cover EUR 3,200)", async () => {
    await seedBoth();
    const r = await getRoutes({ userId: LI_WEI_IDS.user, toCurrency: "EUR", amountMinor: 320_000, dueDate: "2026-11-10" });
    expect(r.routes.length).toBeGreaterThan(0);
    for (const route of r.routes) expect(route.fundingCurrency).toBe("CNY");
  });

  it("coverage forecast: EUR and HUF needs funded from CNY", async () => {
    await seedBoth();
    const f = await forecastCoverage(LI_WEI_IDS.user);
    const eur = f.currencies.find((c) => c.currency === "EUR")!;
    const huf = f.currencies.find((c) => c.currency === "HUF")!;
    const cny = f.currencies.find((c) => c.currency === "CNY")!;
    expect(eur.shortfall).toEqual({ date: "2026-11-10", amountMinor: 275_000 });
    expect(huf.shortfall).toEqual({ date: "2026-11-05", amountMinor: 7_000_000 });
    expect(cny.shortfall).toBeNull();
    expect(f.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromCurrency: "CNY", toCurrency: "EUR", amountMinor: 275_000 }),
        // Y4 (cn D-CN3): sized to the first shortfall (to the reserve), not the horizon end.
        expect.objectContaining({ fromCurrency: "CNY", toCurrency: "HUF", amountMinor: 7_000_000, byDate: "2026-11-05" }),
      ]),
    );
    // Cheapest route per top-up: the large EUR one by the mock bank (fixed fee, low markup), the small HUF one by
    // the CNY card (no fixed fee).
    expect(f.suggestions.find((s) => s.toCurrency === "EUR")?.route?.routeId).toBe("cny-mock-bank:CNY");
    expect(f.suggestions.find((s) => s.toCurrency === "HUF")?.route?.routeId).toBe("cny-card:CNY");
  });

  it("tuition EUR 3,200 is funded from CNY via the mock bank: ASK, signed max, bank debit", async () => {
    await seedBoth();
    const auth = await withPasskey(LI_WEI_IDS.user, "CNY");
    const p = await proposeOrder({
      userId: LI_WEI_IDS.user,
      createdBy: "AGENT",
      payeeId: LI_WEI_IDS.payees.university,
      amountMinor: 320_000,
      currency: "EUR",
      purpose: "Tuition " + LI_WEI_TUITION_REFERENCE,
      category: "tuition",
      obligationId: LI_WEI_IDS.obligations.tuition,
    });
    expect(p.decision).toBe("ASK");
    expect(p.reasonCodes).toEqual(["ABOVE_SMALL_AUTO_LIMIT"]);

    const view = await getOrderView(LI_WEI_IDS.user, p.proposalId);
    expect(view.canonicalOrder).toMatchObject({
      payeeName: "University in Budapest",
      amountMinor: 320_000,
      currency: "EUR",
      rail: "BANK_TRANSFER",
      homeCurrency: "CNY",
      // money/fx test fallback (offlineEnvironment): €3,200 ≈ ¥26,746.27; the sim's example table gives ¥26,560.
      homeAmountMinor: 2_674_627,
    });
    expect(orderFunding(view.canonicalOrder)).toMatchObject({ currency: "CNY", routeId: "cny-mock-bank", markupBps: 50, maxAmountMinor: 2_699_003 });

    // BOLA: Dana cannot see Li's order, neither through the service nor over HTTP.
    await expect(getOrderView(IDS.user, p.proposalId)).rejects.toMatchObject({ status: 404 });
    const probe = await app().inject({ method: "GET", url: `/api/orders/${p.proposalId}`, headers: await bearer(IDS.user) });
    expect(probe.statusCode).toBe(404);

    const res = await approveOrder(LI_WEI_IDS.user, p.proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");

    const transfers = mw!.bank.listTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      sourceCurrency: "CNY",
      sourceAmountMinor: 2_672_280,
      targetCurrency: "EUR",
      targetAmountMinor: 320_000,
      feeMinor: 3000,
    });
    expect(await liWallet("CNY")).toBe(6_000_000 - 2_672_280);

    // Dana's own mock wallet (profile 16000001) is untouched.
    const danaRaw = (await mw!.app.inject({ method: "GET", url: "/mock/v4/profiles/16000001/balances?types=STANDARD" })).json() as Array<{
      currency: string;
      amount: { valueMinor: number };
    }>;
    expect(danaRaw.find((b) => b.currency === "KZT")?.amount.valueMinor).toBe(90_000_000);
  });

  it("demo claim by persona key: li-wei binds to Li, unknown keys are refused, demoClaim true still binds Dana", async () => {
    await seedBoth();

    const ok = await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "li", demoClaim: "li-wei" } });
    expect(ok.statusCode).toBe(200);
    const okBody = ok.json() as { options: { user: { id: string } } };
    expect(Buffer.from(okBody.options.user.id, "base64url").toString("utf8")).toBe(LI_WEI_IDS.user);

    const unknown = await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "x", demoClaim: "nobody" } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "DEMO_PERSONA_UNKNOWN" });

    const dana = await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "dana", demoClaim: true } });
    expect(dana.statusCode).toBe(200);
    const danaBody = dana.json() as { options: { user: { id: string } } };
    expect(Buffer.from(danaBody.options.user.id, "base64url").toString("utf8")).toBe(IDS.user);

    // Without personas seeded, the persona claim is refused (Li has no rows to bind to).
    await seedDatabase(getDb(), await loadSeedData(), { reset: true });
    const notSeeded = await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "li", demoClaim: "li-wei" } });
    expect(notSeeded.statusCode).toBe(409);
    expect(notSeeded.json()).toMatchObject({ code: "DEMO_NOT_SEEDED" });
  });

  it("parents remit CNY to Li's own wallet (alias li-wei)", async () => {
    await seedBoth();
    const res = await mw!.app.inject({ method: "POST", url: "/mock/remittance/incoming", payload: { amountMinor: 1_200_000, currency: "CNY", profileId: "li-wei" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().event.profileId).toBe(16_000_002);
    expect(await liWallet("CNY")).toBe(7_200_000);
  });
});
