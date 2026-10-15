/* Linked accounts (2026-10-16): link a card or bank with the passkey, send from it (the pull leg, then the bank
 * payout, instantly on the mock bank), a declined card, a removed account, and adding money from a linked account. */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { orderHash, type CanonicalOrder } from "@kassa/shared";

import { IDS } from "../../../../fixtures/seed-data.ts";
import { buildMockWorld, type MockWorld } from "../../../mock-world/src/app.ts";
import { FIXTURE_RATES } from "../../../mock-world/src/bank/rates.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { getDb } from "../../src/db/client.ts";
import { fundingSources, ledgerEntries, payees, payments, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();
let mw: MockWorld | null = null;

async function startMockWorld(instant: boolean): Promise<MockWorld> {
  await mw?.app.close();
  mw = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", MOCK_BANK_INSTANT: instant ? "true" : "false" }),
    clock: { now: async () => clock.now() },
    rates: { getRates: async () => FIXTURE_RATES },
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

/** Dana with a passkey and no signed base rules, so every send waits for the passkey (ASK). */
async function seedDana(): Promise<SoftAuthenticator> {
  await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId: IDS.user, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  return auth;
}

async function post(url: string, payload: unknown) {
  return app().inject({ method: "POST", url, headers: await bearer(IDS.user), payload: payload as object });
}

/** Start a link, then confirm it: first call 428 with the challenge, second with the passkey's assertion. */
async function link(auth: SoftAuthenticator, kind: "card" | "bank", body: Record<string, unknown>, code?: (sim: string | undefined) => string | undefined) {
  const start = await post(`/api/funding-sources/${kind}/start`, body);
  expect(start.statusCode).toBe(201);
  const { source, verification } = start.json();
  expect(source.status).toBe("PENDING");
  const withCode = code ? { code: code(verification.simulatedCode) } : {};
  const gate = await post(`/api/funding-sources/${source.id}/confirm`, withCode);
  if (gate.statusCode !== 428) return { source, res: gate };
  const { challengeId, webauthnOptions } = gate.json().details;
  const res = await post(`/api/funding-sources/${source.id}/confirm`, { ...withCode, challengeId, assertion: auth.assert(webauthnOptions.challenge) });
  return { source, res };
}

async function kztPayee() {
  const p = await createPayee(IDS.user, { name: "Mum in Almaty", kind: "PERSON", account: "KZ86125KZT5004100100", country: "KZ", currency: "KZT" });
  await getDb().update(payees).set({ status: "VERIFIED", verifiedAt: clock.now(), coolingUntil: null }).where(eq(payees.id, p.id));
  return p;
}

describe("linked accounts", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    await startMockWorld(true);
  });
  afterAll(async () => {
    setMockWorldTransportForTests(null);
    await mw?.app.close();
  });

  it("links a test card only with the passkey", async () => {
    const auth = await seedDana();
    const { res } = await link(auth, "card", { testCard: "VISA", currency: "KZT" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "CARD", label: "Visa ••4242", currency: "KZT", status: "ACTIVE", simulated: true });

    // A wrong assertion (signed over something else) is refused and the card stays pending.
    const other = (await post("/api/funding-sources/card/start", { testCard: "MASTERCARD", currency: "KZT" })).json();
    const gate = (await post(`/api/funding-sources/${other.source.id}/confirm`, {})).json();
    const bad = await post(`/api/funding-sources/${other.source.id}/confirm`, { challengeId: gate.details.challengeId, assertion: auth.assert("not-the-link-hash") });
    expect(bad.statusCode).toBe(403);

    const list = (await app().inject({ method: "GET", url: "/api/funding-sources", headers: await bearer(IDS.user) })).json();
    // Dana's seeded Visa and Kaspi account come first, then the two linked here.
    expect(list.sources.map((s: { label: string; status: string }) => [s.label, s.status]).slice(-2)).toEqual([
      ["Visa ••4242", "ACTIVE"],
      ["Mastercard ••4444", "PENDING"],
    ]);
  });

  it("links any bank with the one-tenge code and the passkey", async () => {
    const auth = await seedDana();
    const body = { bankName: "Kaspi Gold", account: "KZ12 722C 0000 1234 4417", country: "KZ", currency: "KZT" };
    const wrong = await link(auth, "bank", body, () => "0000");
    expect(wrong.res.statusCode).toBe(422);
    expect(wrong.res.json().code).toBe("CODE_WRONG");

    const { res } = await link(auth, "bank", body, (sim) => sim);
    expect(res.json()).toMatchObject({ kind: "BANK", provider: "MOCK_BANK", label: "Kaspi Gold ••4417", status: "ACTIVE" });
    const row = (await getDb().select().from(fundingSources).where(eq(fundingSources.id, res.json().id)))[0]!;
    expect(row.codeHash).toBeNull();
    expect(JSON.stringify(row)).not.toContain("1234 4417");
  });

  it("sends from a linked card: pulls the signed amount, pays out at once and says how long it took", async () => {
    const auth = await seedDana();
    const card = (await link(auth, "card", { testCard: "VISA", currency: "KZT" })).res.json();
    const mum = await kztPayee();

    const res = await post(`/api/payees/${mum.id}/pay`, { amountMinor: 2_000_000, currency: "KZT", purpose: "Monthly support", fundingSourceId: card.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("ASK");
    const view = await getOrderView(IDS.user, res.json().proposalId);
    expect(view.canonicalOrder).toMatchObject({ fundingSourceId: card.id, fundingCurrency: "KZT", fundingAmountMinor: 2_000_000 + 99_000 });

    const approved = await approveOrder(IDS.user, view.canonicalOrder.proposalId, auth.assert(view.orderHash));
    expect(approved.paymentStatus).toBe("SENT");
    expect(approved.deliveredInMs).toBeGreaterThanOrEqual(0);
    const [transfer] = mw!.bank.listTransfers();
    expect(transfer).toMatchObject({ status: "outgoing_payment_sent", targetAmountMinor: 2_000_000, instant: true });
    const pulled = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "FUNDING_PULLED"));
    expect(pulled[0]?.payload).toMatchObject({ sourceId: card.id, amountMinor: 2_099_000, currency: "KZT", simulated: true });
  });

  it("quotes a send before it is made, from the wallet or a linked account", async () => {
    const auth = await seedDana();
    const card = (await link(auth, "card", { testCard: "VISA", currency: "KZT" })).res.json();
    const mum = await kztPayee();
    const get = async (q: string) => (await app().inject({ method: "GET", url: `/api/send/quote?${q}`, headers: await bearer(IDS.user) })).json();
    const linked = await get(`payeeId=${mum.id}&amountMinor=2000000&fundingSourceId=${card.id}`);
    expect(linked).toMatchObject({ status: "OK", fundingCurrency: "KZT", debitMinor: 2_099_000, maxDebitMinor: 2_099_000, instant: true });
    const wallet = await get(`payeeId=${mum.id}&amountMinor=2000000`);
    expect(wallet.status).toMatch(/OK|NONE/);
  });

  it("a declined card pays nothing out", async () => {
    const auth = await seedDana();
    const card = (await link(auth, "card", { testCard: "DECLINED", currency: "KZT" })).res.json();
    const mum = await kztPayee();
    const p = await proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId: mum.id, amountMinor: 1_000_000, currency: "KZT", purpose: "Support", fundingSourceId: card.id });
    const view = await getOrderView(IDS.user, p.proposalId);
    const approved = await approveOrder(IDS.user, p.proposalId, auth.assert(view.orderHash));
    expect(approved).toMatchObject({ paymentStatus: "FAILED", reasonCodes: ["FUNDING_PULL_DECLINED"] });
    expect(mw!.bank.listTransfers()).toHaveLength(0);
  });

  it("an order signed with an account removed since is refused before anything moves", async () => {
    const auth = await seedDana();
    const card = (await link(auth, "card", { testCard: "VISA", currency: "KZT" })).res.json();
    const mum = await kztPayee();
    const p = await proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId: mum.id, amountMinor: 1_000_000, currency: "KZT", purpose: "Support", fundingSourceId: card.id });
    const view = await getOrderView(IDS.user, p.proposalId);
    const del = await app().inject({ method: "DELETE", url: `/api/funding-sources/${card.id}`, headers: await bearer(IDS.user) });
    expect(del.statusCode).toBe(204);
    const approved = await approveOrder(IDS.user, p.proposalId, auth.assert(view.orderHash));
    expect(approved).toMatchObject({ paymentId: null, reasonCodes: ["FUNDING_SOURCE_UNAVAILABLE"] });
    expect(await getDb().select().from(payments)).toHaveLength(0);

    // And a new order cannot pick it any more.
    const again = await post(`/api/payees/${mum.id}/pay`, { amountMinor: 1_000_000, currency: "KZT", purpose: "Support", fundingSourceId: card.id });
    expect(again.json().code).toBe("FUNDING_SOURCE_UNAVAILABLE");
  });

  it("someone else's linked account cannot be used", async () => {
    await seedDana();
    const foreign = crypto.randomUUID();
    const mum = await kztPayee();
    const res = await post(`/api/payees/${mum.id}/pay`, { amountMinor: 1_000_000, currency: "KZT", purpose: "Support", fundingSourceId: foreign });
    expect(res.statusCode).toBe(422);
  });

  it("without instant payouts the transfer moves on as before", async () => {
    await startMockWorld(false);
    const auth = await seedDana();
    const card = (await link(auth, "card", { testCard: "VISA", currency: "KZT" })).res.json();
    const mum = await kztPayee();
    const p = await proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId: mum.id, amountMinor: 1_000_000, currency: "KZT", purpose: "Support", fundingSourceId: card.id });
    const view = await getOrderView(IDS.user, p.proposalId);
    const approved = await approveOrder(IDS.user, p.proposalId, auth.assert(view.orderHash));
    expect(approved.paymentStatus).toBe("PROCESSING");
    expect(approved.deliveredInMs).toBeUndefined();
  });

  it("the source is part of what the passkey signs", () => {
    const base: CanonicalOrder = {
      v: 1,
      proposalId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      payeeId: crypto.randomUUID(),
      payeeName: "Mum",
      payeeAccountHash: "h",
      amountMinor: 100,
      currency: "KZT",
      rail: "BANK_TRANSFER",
      purpose: "x",
      homeAmountMinor: 100,
      homeCurrency: "KZT",
      mandateId: null,
      nonce: "n",
      expiresAt: new Date(0).toISOString(),
      fundingCurrency: "KZT",
      fundingAmountMinor: 200,
      fundingRouteId: "kzt-mock-bank",
      fundingMarkupBps: 0,
    };
    const a = orderHash({ ...base, fundingSourceId: crypto.randomUUID() });
    expect(a).not.toBe(orderHash(base));
    expect(a).not.toBe(orderHash({ ...base, fundingSourceId: crypto.randomUUID() }));
    const { fundingCurrency: _c, fundingAmountMinor: _a, fundingRouteId: _r, fundingMarkupBps: _m, ...noFunding } = base;
    expect(() => orderHash({ ...noFunding, fundingSourceId: crypto.randomUUID() })).toThrow(RangeError);
  });

  it("adds money to the wallet from a linked bank", async () => {
    const auth = await seedDana();
    const kaspi = (await link(auth, "bank", { bankName: "Kaspi Gold", account: "KZ12722C000012344417", country: "KZ", currency: "KZT" }, (sim) => sim)).res.json();
    const res = await post("/api/wallet/top-ups", { amountMinor: 500_000, currency: "KZT", method: "LINKED", fundingSourceId: kaspi.id, idempotencyKey: crypto.randomUUID() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: "LINKED", provider: "simulated", providerRef: expect.stringMatching(/^sim_bank_debit_/) });
  });
});
