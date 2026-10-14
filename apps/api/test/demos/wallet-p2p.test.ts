/*
 * The agent wallet end to end: a wallet tap adds test money (no real money, no card network in tests), then the user
 * pays another Kassa user by Kassa ID through the ordinary signed-order path, and the money lands in that user's wallet
 * with a notification. Real mock-world bank in process, webhooks delivered back into the API.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { IDS, LI_WEI_IDS, LI_WEI_MOCK_BANK_PROFILE_ID } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, notifications, payees, profiles, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView } from "../../src/modules/rules/index.ts";
import { kassaIdFor } from "../../src/modules/wallet/service.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld | null = null;

async function seedWithPasskey(): Promise<SoftAuthenticator> {
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  const auth = new SoftAuthenticator();
  const row = { userId: IDS.user, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(IDS.user, auth, "KZT");
  return auth;
}

async function wallet(profile: number | string, currency: string): Promise<number> {
  const raw = (await mw!.app.inject({ method: "GET", url: `/mock/v4/profiles/${profile}/balances?types=STANDARD` })).json() as { currency: string; amount: { valueMinor: number } }[];
  return raw.find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
}

const topUp = async (amountMinor: number, currency: string, idempotencyKey = randomUUID()) =>
  app().inject({ method: "POST", url: "/api/wallet/top-ups", headers: await bearer(IDS.user), payload: { amountMinor, currency, method: "APPLE_PAY", idempotencyKey } });

describe("agent wallet: test top-ups and Kassa-to-Kassa", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    clock.setOffsetInMemoryForTests(0);
    await mw?.close();
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw?.close();
  });

  it("a wallet tap adds test money once, ledgered, within the signed per-day cap", async () => {
    await seedWithPasskey();
    const before = await wallet(IDS.user, "EUR");
    const key = randomUUID();
    const res = await topUp(20_000, "EUR", key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amountMinor: 20_000, currency: "EUR", method: "APPLE_PAY", provider: "simulated", simulated: true, balanceAfterMinor: before + 20_000 });
    expect(res.json().providerRef).toMatch(/^sim_tap_/);
    expect(await wallet(IDS.user, "EUR")).toBe(before + 20_000);

    // A double tap (same key) adds nothing more.
    const again = await topUp(20_000, "EUR", key);
    expect(again.json().providerRef).toBe(res.json().providerRef);
    expect(await wallet(IDS.user, "EUR")).toBe(before + 20_000);
    const entries = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "WALLET_TOPUP"));
    expect(entries).toHaveLength(1);

    // Dana's signed per-day cap is ₸2,000,000: €5,000 (≈ ₸3M) in one day is refused.
    const tooMuch = await topUp(500_000, "EUR");
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().code).toBe("TOPUP_DAILY_LIMIT");

    const info = (await app().inject({ method: "GET", url: "/api/wallet", headers: await bearer(IDS.user) })).json();
    expect(info).toMatchObject({ kassaId: kassaIdFor(IDS.user), canTopUp: true, topUpProvider: "simulated", homeCurrency: "KZT" });
    expect(info.topUpTodayHomeMinor).toBeGreaterThan(0);
  });

  it("refuses a top-up outside the capped wallet (handoff users pay with their own apps)", async () => {
    await seedWithPasskey();
    await getDb().update(users).set({ overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: "HANDOFF" } }).where(eq(users.id, IDS.user));
    const res = await topUp(1_000, "EUR");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("TOPUP_NEEDS_WALLET");
  });

  it("tap money in, then pay Li Wei by Kassa ID: signed order, his wallet credited, he is notified", async () => {
    const auth = await seedWithPasskey();
    expect((await topUp(10_000, "EUR")).statusCode).toBe(200);

    const liId = kassaIdFor(LI_WEI_IDS.user);
    const add = await app().inject({
      method: "POST",
      url: "/api/payees",
      headers: await bearer(IDS.user),
      payload: { name: "Li Wei", kind: "PERSON", account: `KASSA:${liId.toLowerCase().replace(/-/g, " ")}`, country: "HU", currency: "EUR" },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().accountMasked).toBe(`Kassa ${liId}`);
    // Cooling as always (I7); skip the 24 h here.
    await getDb().update(payees).set({ status: "VERIFIED", verifiedAt: clock.now(), coolingUntil: null }).where(eq(payees.id, add.json().id));

    const pay = await app().inject({ method: "POST", url: `/api/payees/${add.json().id}/pay`, headers: await bearer(IDS.user), payload: { amountMinor: 5_000, currency: "EUR", purpose: "Concert tickets" } });
    expect(pay.statusCode).toBe(200);
    const { proposalId, decision } = pay.json();
    expect(decision).toBe("ASK");
    const view = await getOrderView(IDS.user, proposalId);
    expect(view.canonicalOrder).toMatchObject({ payeeName: "Li Wei", amountMinor: 5_000, currency: "EUR", rail: "BANK_TRANSFER" });
    expect((await approveOrder(IDS.user, proposalId, auth.assert(view.orderHash))).paymentStatus).toBe("PROCESSING");

    const liBefore = await wallet(LI_WEI_MOCK_BANK_PROFILE_ID, "EUR");
    // The demo clock moves on; the mock bank sends the transfer and delivers it to Li's wallet.
    clock.setOffsetInMemoryForTests(clock.offsetMs() + 2 * 86_400_000);
    await mw!.app.inject({ method: "POST", url: "/mock/bank/tick" });
    expect(await wallet(LI_WEI_MOCK_BANK_PROFILE_ID, "EUR")).toBe(liBefore + 5_000);
    const delivered = await deliverWebhooks(mw!, app());
    expect(delivered.filter((d) => d.kind === "remittance").map((d) => d.statusCode)).toEqual([200]);
    const note = (await getDb().select().from(notifications).where(and(eq(notifications.userId, LI_WEI_IDS.user), eq(notifications.kind, "MONEY_RECEIVED"))))[0];
    expect(note?.title).toBe("Dana sent you 50.00 EUR");
  });

  it("a Kassa ID must exist and must not be your own", async () => {
    await seedWithPasskey();
    const post = async (account: string) =>
      app().inject({ method: "POST", url: "/api/payees", headers: await bearer(IDS.user), payload: { name: "Someone", kind: "PERSON", account, country: "HU", currency: "EUR" } });
    expect((await post(`KASSA:${kassaIdFor(IDS.user)}`)).json().code).toBe("KASSA_ID_SELF");
    expect((await post("KASSA:KSA-AAAA-AAAA")).json().code).toBe("KASSA_ID_UNKNOWN");
    expect((await post("KASSA:KSA-0000-1111")).json().code).toBe("KASSA_ID_INVALID");
  });

  it("a new user without a seeded wallet gets one on the first top-up", async () => {
    await seedWithPasskey();
    await getDb().update(profiles).set({ bankProfileId: null }).where(eq(profiles.userId, IDS.user));
    const res = await topUp(1_500, "EUR");
    expect(res.statusCode).toBe(200);
    expect(res.json().balanceAfterMinor).toBe(1_500);
    const p = (await getDb().select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, IDS.user)))[0]!;
    expect(p.id).toBeGreaterThanOrEqual(30_000_000);
    expect(await wallet(p.id!, "EUR")).toBe(1_500);
  });
});
