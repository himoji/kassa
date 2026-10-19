/*
 * (2026-10-19) Top-up races and linked-account pulls. A top-up key is claimed under the per-user payments lock, for
 * good (not per UTC day), together with the day's total: concurrent taps with one key credit once, concurrent taps
 * with different keys cannot pass the signed per-day cap together, and a retry after midnight returns the first
 * result. A pull from a linked account debits that account's simulated balance and is refused when it is short.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { IDS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { fundingSources, ledgerEntries, linkedAccountSimBalances, linkedAccountSimDebits, walletTopUps } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { simAccountKey, simulatedBalanceOf, simulatedSeedMinor } from "../../src/modules/funding-sources/pull.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld | null = null;

async function wallet(currency: string): Promise<number> {
  const raw = (await mw!.app.inject({ method: "GET", url: `/mock/v4/profiles/${IDS.user}/balances?types=STANDARD` })).json() as { currency: string; amount: { valueMinor: number } }[];
  return raw.find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
}

const topUp = async (payload: { amountMinor: number; currency: string; method?: string; fundingSourceId?: string; idempotencyKey?: string }) =>
  app().inject({
    method: "POST",
    url: "/api/wallet/top-ups",
    headers: await bearer(IDS.user),
    payload: { method: "APPLE_PAY", idempotencyKey: randomUUID(), ...payload },
  });

const topUpEntries = async () => (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "WALLET_TOPUP"))).filter((e) => (e.payload as { userId?: string }).userId === IDS.user);

async function danaSource(kind: "CARD" | "BANK") {
  return (await getDb().select().from(fundingSources).where(and(eq(fundingSources.userId, IDS.user), eq(fundingSources.kind, kind))))[0]!;
}

/** Sets the demo clock so that now is `iso` (UTC). */
function clockAt(iso: string): void {
  clock.setOffsetInMemoryForTests(Date.parse(iso) - Date.now());
}

describe("wallet top-ups under concurrency", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    clock.setOffsetInMemoryForTests(0);
    await mw?.close();
    mw = await startMockWorld();
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  });
  afterAll(async () => {
    clock.setOffsetInMemoryForTests(0);
    await mw?.close();
  });

  it("concurrent top-ups with the same key credit once and return the first result", async () => {
    const before = await wallet("EUR");
    const idempotencyKey = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => topUp({ amountMinor: 20_000, currency: "EUR", idempotencyKey })));
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((x) => x.statusCode !== 200)) expect([409, r.json().code]).toEqual([409, "TOPUP_IN_PROGRESS"]);
    expect(new Set(ok.map((r) => r.json().providerRef)).size).toBe(1);
    expect(await wallet("EUR")).toBe(before + 20_000);
    expect(await topUpEntries()).toHaveLength(1);

    // Once done, a retry returns the original result; the same key with another amount is refused.
    const again = await topUp({ amountMinor: 20_000, currency: "EUR", idempotencyKey });
    expect(again.statusCode).toBe(200);
    expect(again.json().providerRef).toBe(ok[0]!.json().providerRef);
    const other = await topUp({ amountMinor: 30_000, currency: "EUR", idempotencyKey });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe("TOPUP_KEY_REUSED");
    expect(await wallet("EUR")).toBe(before + 20_000);
  });

  it("concurrent top-ups with different keys cannot pass the signed per-day cap together", async () => {
    // Dana's signed per-day cap is ₸2,000,000; ₸1,200,000 fits once, not twice.
    const before = await wallet("KZT");
    const results = await Promise.all([1, 2, 3].map(() => topUp({ amountMinor: 120_000_000, currency: "KZT" })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const refused = results.filter((r) => r.statusCode !== 200);
    expect(refused.map((r) => [r.statusCode, r.json().code])).toEqual([
      [422, "TOPUP_DAILY_LIMIT"],
      [422, "TOPUP_DAILY_LIMIT"],
    ]);
    expect(await wallet("KZT")).toBe(before + 120_000_000);
    const info = (await app().inject({ method: "GET", url: "/api/wallet", headers: await bearer(IDS.user) })).json();
    expect(info.topUpTodayHomeMinor).toBe(120_000_000);
  });

  it("a retry after UTC midnight with the same key does not credit again", async () => {
    clockAt("2026-10-18T23:59:30Z");
    const before = await wallet("EUR");
    const idempotencyKey = randomUUID();
    const first = await topUp({ amountMinor: 15_000, currency: "EUR", idempotencyKey });
    expect(first.statusCode).toBe(200);

    clockAt("2026-10-19T00:00:30Z");
    const retry = await topUp({ amountMinor: 15_000, currency: "EUR", idempotencyKey });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await wallet("EUR")).toBe(before + 15_000);
    expect(await topUpEntries()).toHaveLength(1);
    // The new day starts at zero; yesterday's top-up does not count toward today.
    const info = (await app().inject({ method: "GET", url: "/api/wallet", headers: await bearer(IDS.user) })).json();
    expect(info.topUpTodayHomeMinor).toBe(0);
  });

  it("a failed charge frees the key: nothing is claimed, counted or credited", async () => {
    const card = await danaSource("CARD");
    await getDb().update(fundingSources).set({ providerRef: "pm_card_visa_chargeDeclined" }).where(eq(fundingSources.id, card.id));
    const idempotencyKey = randomUUID();
    const declined = await topUp({ amountMinor: 100_000, currency: "KZT", method: "LINKED", fundingSourceId: card.id, idempotencyKey });
    expect(declined.statusCode).toBe(402);
    expect(declined.json().code).toBe("TOPUP_DECLINED");
    expect(await getDb().select().from(walletTopUps).where(eq(walletTopUps.idempotencyKey, idempotencyKey))).toHaveLength(0);
  });
});

describe("pulls from a linked account debit a simulated balance", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    clock.setOffsetInMemoryForTests(0);
    await mw?.close();
    mw = await startMockWorld();
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  });
  afterAll(async () => {
    await mw?.close();
  });

  it("a bank pull lowers the account's balance, a retry does not, and a pull above what is left is refused", async () => {
    const kaspi = await danaSource("BANK");
    expect(simulatedSeedMinor("KZT")).toBe(500_000_000); // ₸5,000,000 before the first pull
    expect(await simulatedBalanceOf(kaspi)).toBe(500_000_000);
    // As if earlier pulls had left ₸1,000,000 (the per-day cap stops a test from draining ₸5M in one day).
    const seed = 100_000_000;
    await getDb().insert(linkedAccountSimBalances).values({ userId: IDS.user, accountKey: simAccountKey(kaspi), currency: "KZT", balanceMinor: seed, seededMinor: 500_000_000 });
    const before = await wallet("KZT");

    const idempotencyKey = randomUUID();
    const first = await topUp({ amountMinor: 60_000_000, currency: "KZT", method: "LINKED", fundingSourceId: kaspi.id, idempotencyKey });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ provider: "simulated", simulated: true, providerRef: expect.stringMatching(/^sim_bank_debit_/) });
    expect(await simulatedBalanceOf(kaspi)).toBe(seed - 60_000_000);
    expect((await topUpEntries())[0]!.payload).toMatchObject({ method: "LINKED", fundingSourceId: kaspi.id, provider: "simulated", simulated: true });

    // The same top-up again: the original result, no second debit.
    const again = await topUp({ amountMinor: 60_000_000, currency: "KZT", method: "LINKED", fundingSourceId: kaspi.id, idempotencyKey });
    expect(again.json().providerRef).toBe(first.json().providerRef);
    expect(await simulatedBalanceOf(kaspi)).toBe(seed - 60_000_000);

    // ₸600,000 more is above the ₸400,000 left (and under the per-day cap): refused, nothing moves, the key is free.
    const short = await topUp({ amountMinor: 60_000_000, currency: "KZT", method: "LINKED", fundingSourceId: kaspi.id });
    expect(short.statusCode).toBe(402);
    expect(short.json()).toMatchObject({ code: "LINKED_BALANCE_SHORT", reasonCodes: ["FUNDING_PULL_DECLINED"], details: { availableMinor: seed - 60_000_000, currency: "KZT", simulated: true } });
    expect(await simulatedBalanceOf(kaspi)).toBe(seed - 60_000_000);
    expect(await wallet("KZT")).toBe(before + 60_000_000);
    expect(await getDb().select().from(linkedAccountSimDebits)).toHaveLength(1);
  });

  it("a test card without Stripe keys goes through the same simulated balance", async () => {
    const visa = await danaSource("CARD");
    expect(visa.simulated).toBe(true);
    const seed = simulatedSeedMinor("KZT");
    const res = await topUp({ amountMinor: 10_000_000, currency: "KZT", method: "LINKED", fundingSourceId: visa.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().providerRef).toMatch(/^sim_card_charge_/);
    expect(await simulatedBalanceOf(visa)).toBe(seed - 10_000_000);
    // The bank account's balance is its own.
    expect(await simulatedBalanceOf(await danaSource("BANK"))).toBe(seed);
  });

  it("unlinking and linking the same account again does not refill it", async () => {
    const kaspi = await danaSource("BANK");
    const seed = 100_000_000;
    await getDb().insert(linkedAccountSimBalances).values({ userId: IDS.user, accountKey: simAccountKey(kaspi), currency: "KZT", balanceMinor: seed, seededMinor: 500_000_000 });
    expect((await topUp({ amountMinor: 90_000_000, currency: "KZT", method: "LINKED", fundingSourceId: kaspi.id })).statusCode).toBe(200);
    // A second row for the same underlying account (same provider ref), as a relink would create.
    const relinked = (await getDb().insert(fundingSources).values({ ...kaspi, id: randomUUID(), createdAt: clock.now() }).returning())[0]!;
    await getDb().update(fundingSources).set({ status: "REMOVED" }).where(eq(fundingSources.id, kaspi.id));
    expect(await simulatedBalanceOf(relinked)).toBe(seed - 90_000_000);
    const res = await topUp({ amountMinor: 20_000_000, currency: "KZT", method: "LINKED", fundingSourceId: relinked.id });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("LINKED_BALANCE_SHORT");
  });
});
