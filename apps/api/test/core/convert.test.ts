/*
 * (2026-10-18) CONVERT orders: an exchange between the user's own wallet balances, so the hero can pay EUR tuition from
 * money she holds in KZT. Always ASK (passkey over the canonical order), never AUTO; outside the payment caps; payments
 * re-checks the shape (own wallet only, T2 only) and the bank quote against the signed maximum; the ledger records the
 * exchange; obligations report CONVERTIBLE with the conversions that make a bill payable; the planner can propose one.
 *
 * The bank here is a contract-level fake of Wise's quote / balances / balance-movements routes (rails/convert.ts), priced
 * by the API's own route optimizer, with knobs for a moved rate and a balance spent in between. The real mock bank's
 * conversion runs end to end in test/core/funding.test.ts ("tuition: CONVERTIBLE → …").
 */
import { orderConversion, orderFunding, orderHash, ownWalletAccountHash, type CanonicalOrder } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, obligations, payments, profiles, proposals, transactions, users } from "../../src/db/schema.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { getRoutes } from "../../src/modules/fx/routes.ts";
import { forecastCoverage } from "../../src/modules/fx/index.ts";
import { billRail, coverageOf } from "../../src/modules/obligations/coverage.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setBalanceProviderForTests, usedHomeSince } from "../../src/modules/rules/facts.ts";
import { bankRails } from "../../src/modules/rules/funding.ts";
import { approveOrder, getOrderView, proposeConversion, proposeOrder } from "../../src/modules/rules/index.ts";
import { orderFactsText } from "../../src/modules/agent/turn-summary.ts";
import { addObligation, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { forgeSignedApproval } from "../helpers/forge.ts";
import { runAgentTurn, scriptedPlanner } from "../helpers/planner.ts";

const t = useTestDb();
const PROFILE = 777_001;

/** The fake bank's wallet and its knobs. */
const bank = {
  wallet: new Map<string, number>(),
  /** Added to every quote's source amount (a rate move after signing). */
  quoteBump: 0,
  /** The next balance movement answers 422 insufficient funds (balance spent elsewhere in between). */
  failNextMovement: false,
  quotes: new Map<string, { src: string; tgt: string; sourceAmountMinor: number; targetAmountMinor: number }>(),
  movements: new Map<string, { id: number; quoteId: string }>(),
  calls: [] as string[],
};

function useFakeBank(): void {
  setBalanceProviderForTests(async () => [...bank.wallet].map(([currency, amountMinor]) => ({ currency, amountMinor })));
  setMockWorldTransportForTests(async (method, path, body) => {
    bank.calls.push(`${method} ${path.split("?")[0]}`);
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === "GET" && path.startsWith(`/v4/profiles/${PROFILE}/balances`)) {
      return { status: 200, json: [...bank.wallet].map(([currency, valueMinor]) => ({ currency, amount: { valueMinor, currency } })) };
    }
    if (method === "POST" && path === `/v3/profiles/${PROFILE}/quotes`) {
      const src = String(b.sourceCurrency);
      const tgt = String(b.targetCurrency);
      const target = Number(b.targetAmountMinor);
      const rails = bankRails().filter((r) => r.id === b.routeId);
      const priced = await getRoutes({ amountMinor: target, toCurrency: tgt, homeCurrency: "KZT", today: isoDate(clock.now()), balances: [{ currency: src, amountMinor: Number.MAX_SAFE_INTEGER }], rails, top: 1 });
      const id = `00000000-0000-4000-8000-${String(bank.quotes.size + 1).padStart(12, "0")}`;
      const q = { src, tgt, sourceAmountMinor: priced[0]!.totalDebitFundingMinor + bank.quoteBump, targetAmountMinor: target };
      bank.quotes.set(id, q);
      return { status: 200, json: { id, sourceCurrency: src, targetCurrency: tgt, sourceAmountMinor: q.sourceAmountMinor, targetAmountMinor: target } };
    }
    if (method === "POST" && path === `/v2/profiles/${PROFILE}/balance-movements`) {
      const key = String(b.customerTransactionId);
      const seen = bank.movements.get(key);
      if (seen) return { status: 200, json: { id: seen.id, state: "COMPLETED" } };
      const q = bank.quotes.get(String(b.quoteId));
      if (!q) return { status: 404, json: null };
      const have = bank.wallet.get(q.src) ?? 0;
      if (bank.failNextMovement || have < q.sourceAmountMinor) {
        bank.failNextMovement = false;
        return { status: 422, json: { errors: [{ code: "transfer.insufficient_funds" }] } };
      }
      bank.wallet.set(q.src, have - q.sourceAmountMinor);
      bank.wallet.set(q.tgt, (bank.wallet.get(q.tgt) ?? 0) + q.targetAmountMinor);
      const id = 900_000 + bank.movements.size;
      bank.movements.set(key, { id, quoteId: String(b.quoteId) });
      return { status: 200, json: { id, type: "CONVERSION", state: "COMPLETED", sourceAmountMinor: q.sourceAmountMinor, targetAmountMinor: q.targetAmountMinor, rate: "0.0018" } };
    }
    return { status: 404, json: null };
  });
}

/** Dana-like: KZT home, ₸1,350,000 and EUR 300 in the wallet (EUR 1 = ₸612.40: neither pays EUR 2,400 alone). */
async function dana() {
  const u = await createUserWithPasskey({ preset: "SMART" });
  await getDb().update(profiles).set({ bankProfileId: PROFILE }).where(eq(profiles.userId, u.userId));
  bank.wallet = new Map([
    ["KZT", 135_000_000],
    ["EUR", 30_000],
  ]);
  return u;
}

const kztToEur = (userId: string, amountMinor = 210_000) => proposeConversion({ userId, createdBy: "USER", toCurrency: "EUR", amountMinor, fromCurrency: "KZT" });

describe("CONVERT orders: own balance → own balance", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    useFakeBank();
    bank.quoteBump = 0;
    bank.failNextMovement = false;
    bank.quotes.clear();
    bank.movements.clear();
    bank.calls = [];
    clock.freezeForTests(null);
  });
  afterAll(() => setMockWorldTransportForTests(null));

  it("is always ASK with CONVERT_OWN_BALANCES, and the canonical order credits only the user's own wallet", async () => {
    const { userId } = await dana();
    const r = await kztToEur(userId);
    expect(r).toMatchObject({ decision: "ASK", reasonCodes: ["CONVERT_OWN_BALANCES"] });
    const view = await getOrderView(userId, r.proposalId);
    const order = view.canonicalOrder as CanonicalOrder;
    expect(order).toMatchObject({ rail: "CONVERT", payeeId: userId, payeeAccountHash: ownWalletAccountHash(userId), amountMinor: 210_000, currency: "EUR", mandateId: null });
    expect(orderConversion(order)).toMatchObject({ fromCurrency: "KZT", toCurrency: "EUR", amountMinor: 210_000, routeId: "kzt-mock-bank" });
    expect(view.orderHash).toBe(orderHash(order));
    expect(view.payeeStatus).toBe("VERIFIED");
    expect(view.webauthnOptions?.challenge).toBe(view.orderHash);
    expect(r.summary).toContain("convert from your KZT balance into EUR 2,100.00");
  });

  it("is never AUTO, even small, under SMART with passkey-signed base rules (no new auto-pay path)", async () => {
    const { userId, auth } = await dana();
    await signBaseRules(userId, auth);
    const r = await kztToEur(userId, 100); // EUR 1.00
    expect(r.decision).toBe("ASK");
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("approved with the passkey: the bank converts, the ledger records it, no spending is logged and no cap is used", async () => {
    const { userId, auth } = await dana();
    const r = await kztToEur(userId);
    const view = await getOrderView(userId, r.proposalId);
    const max = orderFunding(view.canonicalOrder as CanonicalOrder)!.maxAmountMinor;
    const res = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    expect(res).toMatchObject({ paymentStatus: "SENT", reasonCodes: [] });
    expect(bank.wallet.get("EUR")).toBe(240_000);
    const debited = 135_000_000 - bank.wallet.get("KZT")!;
    expect(debited).toBeGreaterThan(0);
    expect(debited).toBeLessThanOrEqual(max);
    const [pay] = await getDb().select().from(payments);
    expect(pay).toMatchObject({ rail: "CONVERT", status: "SENT", amountMinor: 210_000, currency: "EUR" });
    const converted = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "WALLET_CONVERTED")))[0]!.payload;
    expect(converted).toMatchObject({ userId, sourceCurrency: "KZT", sourceAmountMinor: debited, targetCurrency: "EUR", targetAmountMinor: 210_000, routeId: "kzt-mock-bank" });
    expect(await getDb().select().from(transactions)).toHaveLength(0); // an exchange, not spending
    expect(await usedHomeSince(getDb(), userId, new Date(0))).toBe(0); // outside the payment caps
    // Re-executing the same approval: the nonce is spent, nothing converts twice.
    expect((await executeApproval(res.approvalId)).reasonCodes).toEqual(["NONCE_USED"]);
    expect(bank.wallet.get("EUR")).toBe(240_000);
  });

  it("then the tuition is payable from EUR (convert, then pay)", async () => {
    const { userId, auth } = await dana();
    const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const before = await proposeOrder({ userId, createdBy: "USER", payeeId: uni.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    expect(before.reasonCodes).toEqual(["INSUFFICIENT_FUNDS"]);
    const c = await kztToEur(userId, 210_050); // the gap: EUR 2,400 + the EUR route's EUR 0.50 fee − EUR 300
    const v = await getOrderView(userId, c.proposalId);
    await approveOrder(userId, c.proposalId, auth.assert(v.orderHash));
    const after = await proposeOrder({ userId, createdBy: "USER", payeeId: uni.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    expect(after.decision).toBe("ASK");
    const pv = await getOrderView(userId, after.proposalId);
    expect(orderFunding(pv.canonicalOrder as CanonicalOrder)).toMatchObject({ currency: "EUR", routeId: "eur-mock-bank" });
  });

  it("refuses without a signable order: no balance covers it, balances unreadable, frozen", async () => {
    const { userId } = await dana();
    expect((await kztToEur(userId, 100_000_000)).reasonCodes).toEqual(["INSUFFICIENT_FUNDS"]);
    setBalanceProviderForTests(async () => null);
    expect((await kztToEur(userId)).reasonCodes).toEqual(["BALANCES_UNAVAILABLE"]);
    useFakeBank();
    await getDb().update(users).set({ frozenAt: clock.now() }).where(eq(users.id, userId));
    expect((await kztToEur(userId)).reasonCodes).toEqual(["REFUSE_FROZEN"]);
    const rows = await getDb().select().from(proposals);
    expect(rows.every((p) => p.canonicalOrder === null && p.status === "REFUSED")).toBe(true);
    await expect(proposeConversion({ userId, createdBy: "USER", toCurrency: "EUR", amountMinor: 100, fromCurrency: "EUR" })).rejects.toMatchObject({ status: 400 });
  });

  it("the bank quotes above the signed maximum (rate moved): FAILED FUNDING_ABOVE_SIGNED_MAX, balances unchanged", async () => {
    const { userId, auth } = await dana();
    const r = await kztToEur(userId);
    const view = await getOrderView(userId, r.proposalId);
    bank.quoteBump = 10_000_000; // ₸100,000 more than priced at proposal
    const res = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    expect(res).toMatchObject({ paymentStatus: "FAILED", reasonCodes: ["FUNDING_ABOVE_SIGNED_MAX"] });
    expect(bank.wallet.get("KZT")).toBe(135_000_000);
    expect(bank.calls).not.toContain(`POST /v2/profiles/${PROFILE}/balance-movements`);
  });

  it("the bank refuses for want of money at conversion: FAILED INSUFFICIENT_FUNDS, not RAIL_ERROR", async () => {
    const { userId, auth } = await dana();
    const r = await kztToEur(userId);
    const view = await getOrderView(userId, r.proposalId);
    bank.failNextMovement = true;
    const res = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    expect(res).toMatchObject({ paymentStatus: "FAILED", reasonCodes: ["INSUFFICIENT_FUNDS"] });
    expect(bank.wallet.get("EUR")).toBe(30_000);
  });

  it("payments re-checks on its own: a conversion approved T1 by a rules bug is refused, and a conversion to another wallet cannot be hashed", async () => {
    const { userId, auth } = await dana();
    const wallet = { id: userId, userId, name: "Your Kassa wallet", accountHash: ownWalletAccountHash(userId) } as Parameters<typeof forgeSignedApproval>[0];
    const conv = { rail: "CONVERT" as const, amountMinor: 210_000, currency: "EUR", homeAmountMinor: 117_600_000, fundingCurrency: "KZT", fundingAmountMinor: 130_000_000, fundingRouteId: "kzt-mock-bank", fundingMarkupBps: 55 };
    const t1 = await forgeSignedApproval(wallet, { ...conv, tier: "T1" });
    expect((await executeApproval(t1.approvalId)).reasonCodes).toEqual(["NO_APPROVAL"]);
    const t2 = await forgeSignedApproval(wallet, { ...conv, tier: "T2", sign: (h) => auth.assert(h) });
    expect((await executeApproval(t2.approvalId)).status).toBe("SENT");
    const other = await createUserWithPasskey();
    const stolen = { ...wallet, accountHash: ownWalletAccountHash(other.userId) } as Parameters<typeof forgeSignedApproval>[0];
    await expect(forgeSignedApproval(stolen, { ...conv, tier: "T2" })).rejects.toThrow(/own wallet/);
  });
});

describe("obligation coverage: CONVERTIBLE with its plan", () => {
  const now = new Date("2026-10-18T10:00:00Z");
  const bill = { amountMinor: 240_000, currency: "EUR", dueDate: "2026-11-01", payeeKind: "UNIVERSITY", payeeAccountHash: "h" };
  beforeEach(() => offlineEnvironment());

  it("EUR 2,400 with EUR 300 and ₸1,350,000: convert the gap (bill + fee − EUR balance) from KZT, then pay from EUR", async () => {
    const c = await coverageOf(bill, { userId: "u", homeCurrency: "KZT", now, balances: [{ currency: "EUR", amountMinor: 30_000 }, { currency: "KZT", amountMinor: 135_000_000 }] });
    expect(c.coverage).toBe("CONVERTIBLE");
    expect(c.conversions).toEqual([expect.objectContaining({ fromCurrency: "KZT", toCurrency: "EUR", amountMinor: 210_050, routeId: "kzt-mock-bank" })]);
  });

  it("no single balance covers the gap: two conversions, largest balance first", async () => {
    const c = await coverageOf(bill, {
      userId: "u",
      homeCurrency: "KZT",
      now,
      balances: [
        { currency: "EUR", amountMinor: 30_000 },
        { currency: "KZT", amountMinor: 70_000_000 }, // ≈ EUR 1,250
        { currency: "USD", amountMinor: 120_000 }, // ≈ EUR 1,100
      ],
    });
    expect(c.coverage).toBe("CONVERTIBLE");
    expect(c.conversions!.length).toBe(2);
    expect(c.conversions!.reduce((s, x) => s + x.amountMinor, 0)).toBe(210_050);
  });

  it("a plan that would leave the wallet below the protected reserve is SHORTFALL (reserveBreached), as rules would refuse it", async () => {
    const balances = [{ currency: "EUR", amountMinor: 30_000 }, { currency: "KZT", amountMinor: 135_000_000 }];
    const ok = await coverageOf(bill, { userId: "u", homeCurrency: "KZT", now, balances, reserveHomeMinor: 1_000_000 });
    expect(ok.coverage).toBe("CONVERTIBLE");
    const blocked = await coverageOf(bill, { userId: "u", homeCurrency: "KZT", now, balances, reserveHomeMinor: 50_000_000 });
    expect(blocked).toMatchObject({ coverage: "SHORTFALL", reserveBreached: true });
  });

  it("the balances together do not cover it: SHORTFALL; one balance does: COVERED", async () => {
    expect((await coverageOf(bill, { userId: "u", homeCurrency: "KZT", now, balances: [{ currency: "EUR", amountMinor: 30_000 }, { currency: "KZT", amountMinor: 1_000_000 }] })).coverage).toBe("SHORTFALL");
    expect((await coverageOf(bill, { userId: "u", homeCurrency: "KZT", now, balances: [{ currency: "KZT", amountMinor: 500_000_000 }] })).coverage).toBe("COVERED");
    expect((await coverageOf(bill, { userId: "u", homeCurrency: "KZT", now, balances: null })).coverage).toBe("UNKNOWN");
  });
});

describe("the planner proposes a conversion; the turn ends with the signed order", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    useFakeBank();
  });

  it("propose_order kind CONVERT → an ASK conversion, orderLine in the tool result and on the card (\"Order to sign\"), not repeated in the app's reply", async () => {
    const { userId } = await dana();
    const planner = scriptedPlanner((n) =>
      n === 0
        ? { toolCalls: [{ toolName: "propose_order", input: { kind: "CONVERT", amountMinor: 210_050, currency: "EUR", fromCurrency: "KZT", purpose: "Top up EUR for tuition" } }] }
        : { text: "I set up a conversion from your USD balance." },
    );
    const r = await runAgentTurn({ userId, text: "convert enough for tuition", planner });
    expect(r.ctx.proposals).toHaveLength(1);
    expect(r.ctx.proposals[0]).toMatchObject({ decision: "ASK", reasonCodes: ["CONVERT_OWN_BALANCES"] });
    const line = r.ctx.orderLines![0]!;
    expect(line).toContain("convert from your KZT balance into EUR 2,100.50");
    // (2026-10-19) Not signed yet: worded as an order to sign.
    expect(line.startsWith("Order to sign: ")).toBe(true);
    expect(line).not.toContain("Signed order");
    // The model's text names the wrong balance; the card under the reply carries the order, so the app's reply does
    // not repeat it as text (it did twice before: the card's block and an appended text part).
    expect(r.text).toContain("from your USD balance");
    expect(r.text).not.toContain(orderFactsText([line]));
    const card = r.emitted.find((c) => c.type === "data-proposal") as { data: { kind?: string; orderLine?: string; orderFacts?: unknown; funding?: { currency: string } } } | undefined;
    expect(card?.data).toMatchObject({ kind: "CONVERT", orderLine: line, funding: { currency: "KZT" }, orderFacts: { stance: "TO_SIGN", rail: "CONVERT", linkedAccount: false, conversion: { fromCurrency: "KZT", toCurrency: "EUR", amountMinor: 210_050 } } });
  });

  it("a payment without payeeRef is answered with an error, never a proposal", async () => {
    const { userId } = await dana();
    const planner = scriptedPlanner((n) => (n === 0 ? { toolCalls: [{ toolName: "propose_order", input: { amountMinor: 100, currency: "EUR", purpose: "x" } }] } : { text: "ok" }));
    const r = await runAgentTurn({ userId, text: "pay", planner });
    expect(r.ctx.proposals).toHaveLength(0);
  });
});

describe("bills and the forecast agree (judge: CNY dorm COVERED in /obligations, a CNY 1,800 shortfall in the forecast)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  async function dormCase(region: "EU" | "CN") {
    const { userId } = await createUserWithPasskey({ region });
    setBalanceProviderForTests(async () => [{ currency: "KZT", amountMinor: 135_000_000 }]); // no CNY at all
    const dorm = await addPayee(userId, { name: "Shanghai Dorm Office", kind: "LANDLORD", currency: "CNY" });
    const due = isoDate(new Date(clock.now().getTime() + 10 * 86_400_000));
    await addObligation(userId, dorm.id, { amountMinor: 180_000, currency: "CNY", category: "rent", dueDate: due, recurrence: "ONCE" });
    const [o] = await getDb().select().from(obligations).where(eq(obligations.userId, userId));
    const u = (await getDb().select().from(users).where(eq(users.id, userId)))[0]!;
    const cov = await coverageOf({ ...o!, payeeKind: "LANDLORD", payeeAccountHash: dorm.accountHash }, { userId, homeCurrency: "KZT", now: clock.now(), balances: [{ currency: "KZT", amountMinor: 135_000_000 }], rail: billRail(u, "LANDLORD") });
    const f = await forecastCoverage(userId);
    return { cov, cny: f.currencies.find((c) => c.currency === "CNY"), kzt: f.currencies.find((c) => c.currency === "KZT")! };
  }

  it("EU (bank transfer, the bank converts KZT → CNY): COVERED, and the forecast draws the bill from KZT, no CNY shortfall", async () => {
    const { cov, cny, kzt } = await dormCase("EU");
    expect(cov).toMatchObject({ coverage: "COVERED", bestRoute: expect.objectContaining({ fundingCurrency: "KZT" }) });
    expect(cny?.shortfall ?? null).toBeNull();
    expect(kzt.points.at(-1)!.balanceMinor).toBeLessThan(135_000_000); // the dorm bill lowers KZT
  });

  it("CN (handoff, paid in CNY by the user): CONVERTIBLE (KZT → CNY first), and the forecast shows the CNY need", async () => {
    const { cov, cny } = await dormCase("CN");
    expect(cov.coverage).toBe("CONVERTIBLE");
    expect(cov.conversions?.[0]).toMatchObject({ fromCurrency: "KZT", toCurrency: "CNY" });
    expect(cny?.shortfall).toMatchObject({ amountMinor: 180_000 });
  });
});
