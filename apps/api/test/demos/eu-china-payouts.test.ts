/*
 * Cross-border payouts through the bank rail, per payee scheme (shared/payeeAccount.ts):
 *  - EU → China: Dana's wallet pays CNY to an Alipay ID and to a UnionPay card (Wise chinese_alipay / chinese_card);
 *  - US: Dana pays USD by ACH (Wise aba);
 *  - China → EU is Li Wei's tuition (cn3-li-wei.test.ts).
 * Against the real mock-world bank (in process), then the same flow against a recorded Wise-sandbox transport.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../../../mock-world/src/app.ts";
import { FIXTURE_RATES } from "../../../mock-world/src/bank/rates.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { IDS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { payees, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { setWiseTransportForTests, type WiseTransport } from "../../src/modules/rails/bankApi.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { getTransferStatus } from "../../src/modules/rails/mockBank.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();

let mw: MockWorld | null = null;

async function startMockWorld(): Promise<MockWorld> {
  await mw?.app.close();
  mw = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
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

async function seedDana(): Promise<SoftAuthenticator> {
  await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId: IDS.user, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(IDS.user, auth, "KZT");
  return auth;
}

/** A payee added through the real create path (scheme validation, encryption), then past cooling and verified. */
async function verifiedPayee(req: { name: string; account: string; country: string; currency: string }) {
  const p = await createPayee(IDS.user, { ...req, kind: "PERSON" });
  await getDb().update(payees).set({ status: "VERIFIED", verifiedAt: clock.now(), coolingUntil: null }).where(eq(payees.id, p.id));
  return p;
}

async function pay(auth: SoftAuthenticator, payeeId: string, amountMinor: number, currency: string, purpose: string) {
  const p = await proposeOrder({ userId: IDS.user, createdBy: "USER", payeeId, amountMinor, currency, purpose });
  expect(p.decision).not.toBe("REFUSE");
  const view = await getOrderView(IDS.user, p.proposalId);
  expect(view.canonicalOrder.rail).toBe("BANK_TRANSFER");
  return approveOrder(IDS.user, p.proposalId, auth.assert(view.orderHash));
}

describe("payouts by scheme through the mock bank", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    await startMockWorld();
  });
  afterAll(async () => {
    setMockWorldTransportForTests(null);
    await mw?.app.close();
  });

  it("EU → China: CNY to an Alipay ID and to a UnionPay card", async () => {
    const auth = await seedDana();
    const alipay = await verifiedPayee({ name: "Li Wei", account: "ALIPAY:li.wei@example.cn", country: "CN", currency: "CNY" });
    const unionpay = await verifiedPayee({ name: "Zhang Min", account: "UNIONPAY:6200000000000005", country: "CN", currency: "CNY" });

    expect((await pay(auth, alipay.id, 50_000, "CNY", "Shared flat deposit")).paymentStatus).toBe("PROCESSING");
    expect((await pay(auth, unionpay.id, 20_000, "CNY", "Concert tickets")).paymentStatus).toBe("PROCESSING");

    const transfers = mw!.bank.listTransfers();
    expect(transfers.map((x) => [x.targetCurrency, x.targetAmountMinor])).toEqual([
      ["CNY", 50_000],
      ["CNY", 20_000],
    ]);
    const recipients = transfers.map((x) => mw!.bank.getRecipient(x.targetAccount));
    expect(recipients.map((r) => [r.type, r.country, r.details])).toEqual([
      ["chinese_alipay", "CN", { legalType: "PRIVATE", accountNumber: "li.wei@example.cn" }],
      ["chinese_card", "CN", { legalType: "PRIVATE", cardNumber: "6200000000000005" }],
    ]);
  });

  it("US: USD by ACH (routing + account number)", async () => {
    const auth = await seedDana();
    const ach = await verifiedPayee({ name: "Course Provider in Boston", account: "ACH:021000021:123456789:CHECKING", country: "US", currency: "USD" });
    expect((await pay(auth, ach.id, 10_000, "USD", "Summer course")).paymentStatus).toBe("PROCESSING");
    const [transfer] = mw!.bank.listTransfers();
    expect(mw!.bank.getRecipient(transfer!.targetAccount)).toMatchObject({
      type: "aba",
      country: "US",
      currency: "USD",
      details: { abartn: "021000021", accountNumber: "123456789", accountType: "CHECKING" },
    });
  });

  it("refuses scheme details that are wrong or cannot take the currency, before any payee exists", async () => {
    await seedDana();
    const post = async (payload: Record<string, string>) =>
      app().inject({ method: "POST", url: "/api/payees", headers: await bearer(IDS.user), payload: { name: "Someone", kind: "PERSON", ...payload } });

    const wrongCurrency = await post({ account: "ALIPAY:li.wei@example.cn", country: "CN", currency: "EUR" });
    expect(wrongCurrency.statusCode).toBe(422);
    expect(wrongCurrency.json()).toMatchObject({ code: "SCHEME_CURRENCY_MISMATCH", details: { field: "currency" } });

    const badCard = await post({ account: "UNIONPAY:6200000000000006", country: "CN", currency: "CNY" });
    expect(badCard.json()).toMatchObject({ code: "UNIONPAY_CARD_INVALID", details: { field: "cardNumber" } });

    const badRouting = await post({ account: "ACH:021000022:123456789:CHECKING", country: "US", currency: "USD" });
    expect(badRouting.json()).toMatchObject({ code: "ACH_ROUTING_INVALID", details: { field: "routingNumber" } });

    const ok = await post({ account: "ALIPAY:+86 138 0013 8000", country: "CN", currency: "CNY" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().accountMasked).toBe("Alipay •••• 8000");
  });
});

describe("the same rail against the Wise sandbox (recorded responses)", () => {
  const calls: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
  let state = "incoming_payment_waiting";

  /** Wise-shaped answers: decimal amounts, paymentOptions on quotes, 403 on balance funding (PSD2 SCA). */
  const wiseSandbox: WiseTransport = async (method, url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, auth: init.headers.authorization, body });
    const path = new URL(url).pathname;
    if (path === "/v4/profiles/4242/balances") return { status: 200, json: [{ currency: "EUR", amount: { value: 5000.0, currency: "EUR" } }, { currency: "KZT", amount: { value: 2_000_000, currency: "KZT" } }] };
    if (path === "/v3/profiles/4242/quotes") {
      const target = Number(body!.targetAmount);
      return {
        status: 200,
        json: {
          id: "11111111-2222-4333-8444-555555555555",
          sourceCurrency: body!.sourceCurrency,
          targetCurrency: body!.targetCurrency,
          rate: 8.3,
          paymentOptions: [
            { payIn: "BANK_TRANSFER", payOut: "BANK_TRANSFER", sourceAmount: 99999, targetAmount: target, disabled: false },
            { payIn: "BALANCE", payOut: "BANK_TRANSFER", sourceAmount: 1.23, targetAmount: target, disabled: false },
          ],
        },
      };
    }
    if (path === "/v1/accounts") return { status: 200, json: { id: 9001, ...body } };
    if (path === "/v1/transfers") return { status: 200, json: { id: 777, status: "incoming_payment_waiting" } };
    if (path === "/v3/profiles/4242/transfers/777/payments") return { status: 403, json: { errors: [{ code: "SCA_REQUIRED", message: "Strong customer authentication required" }] } };
    if (path === "/v1/transfers/777") return { status: 200, json: { id: 777, status: state } };
    const sim = /^\/v1\/simulation\/transfers\/777\/(\w+)$/.exec(path);
    if (sim) {
      state = sim[1]!;
      return { status: 200, json: { id: 777, status: state } };
    }
    return { status: 404, json: { errors: [{ code: "NOT_FOUND", message: path }] } };
  };

  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    calls.length = 0;
    state = "incoming_payment_waiting";
    setEnvForTests({ WISE_SANDBOX_TOKEN: "sandbox-test-token", WISE_PROFILE_ID: "4242" });
    setWiseTransportForTests(wiseSandbox);
  });
  afterEach(() => {
    setEnvForTests({ WISE_SANDBOX_TOKEN: "", WISE_PROFILE_ID: "" });
    setWiseTransportForTests(null);
  });

  it("quotes in decimals, creates an Alipay recipient, moves the transfer on with sandbox simulation", async () => {
    const auth = await seedDana();
    const alipay = await verifiedPayee({ name: "Li Wei", account: "ALIPAY:li.wei@example.cn", country: "CN", currency: "CNY" });
    const res = await pay(auth, alipay.id, 50_000, "CNY", "Shared flat deposit");
    expect(res.paymentStatus).toBe("PROCESSING");

    expect(calls.every((c) => c.auth === "Bearer sandbox-test-token" && c.url.startsWith("https://api.sandbox.transferwise.tech/"))).toBe(true);
    const quote = calls.find((c) => c.url.endsWith("/v3/profiles/4242/quotes"))!;
    expect(quote.body).toEqual({ sourceCurrency: expect.any(String), targetCurrency: "CNY", targetAmount: 500, payOut: "BANK_TRANSFER" });
    expect(calls.find((c) => c.url.endsWith("/v1/accounts"))!.body).toEqual({
      profile: 4242,
      currency: "CNY",
      accountHolderName: "Li Wei",
      type: "chinese_alipay",
      details: { legalType: "PRIVATE", accountNumber: "li.wei@example.cn" },
    });
    // Funding was refused (SCA) so the sandbox simulation moved it to processing; each poll steps it on.
    expect(state).toBe("processing");
    expect(await getTransferStatus("777")).toBe("PROCESSING");
    expect(state).toBe("funds_converted");
    expect(await getTransferStatus("777")).toBe("SENT");
  });

  it("never talks to a live Wise host", async () => {
    setEnvForTests({ WISE_API_URL: "https://api.wise.com" });
    await expect(getTransferStatus("1")).rejects.toThrow(/sandbox host/);
    setEnvForTests({ WISE_API_URL: "" });
  });
});
