import { randomUUID } from "node:crypto";

import { convertMinor, crossRate } from "@kassa/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { BankError, MockBank, TRANSFER_STATES } from "../src/bank/bank.ts";
import { FIXTURE_RATES, StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { MemoryBalanceStore } from "../src/store/memory.ts";
import { RecordingSink } from "../src/webhooks.ts";

const PROFILE = 16_000_001;
const ALIAS = "c83d27e3-4e03-570f-8fea-87db32399c12";
const IBAN = "HU92104051760049812600000008";
const STEP_MS = 20_000;

interface Ctx {
  clock: ManualClock;
  sink: RecordingSink;
  bank: MockBank;
}

function makeCtx(): Ctx {
  const clock = new ManualClock(Date.parse("2026-10-27T09:00:00Z"));
  const sink = new RecordingSink();
  const bank = new MockBank({
    clock,
    rates: new StaticRates(),
    webhooks: sink,
    stepMs: STEP_MS,
    store: new MemoryBalanceStore(
      [
        {
          profileId: PROFILE,
          aliases: [ALIAS],
          balances: [
            { currency: "EUR", amountMinor: 30_000 },
            { currency: "KZT", amountMinor: 90_000_000 },
          ],
        },
      ],
      1000,
    ),
  });
  return { clock, sink, bank };
}

function recipientFor(bank: MockBank, iban = IBAN) {
  return bank.createRecipient({
    currency: "EUR",
    profile: PROFILE,
    accountHolderName: "Student Insurer in EU",
    legalType: "BUSINESS",
    iban,
  });
}

/** A same-currency EUR quote (9600 target, fee 50) plus a recipient and a transfer on it. */
async function createFundableTransfer(ctx: Ctx) {
  const quote = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 });
  const recipient = await recipientFor(ctx.bank);
  const { transfer } = await ctx.bank.createTransfer({
    targetAccount: recipient.id,
    quoteUuid: quote.id,
    customerTransactionId: randomUUID(),
    reference: "POL-778201-Q4",
  });
  return { quote, recipient, transfer };
}

interface SentBody {
  data: { current_state: string; previous_state: string; occurred_at: string };
  event_type: string;
}

function sentBodies(sink: RecordingSink): SentBody[] {
  return sink.sent.map((s) => s.body as SentBody);
}

describe("quotes", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("same-currency quote: rate 1, fee 50 minor, source = target + fee", async () => {
    const q = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 });
    expect(q.rate).toBe("1");
    expect(q.fee.totalMinor).toBe(50);
    expect(q.sourceAmountMinor).toBe(9650);
    expect(q.targetAmountMinor).toBe(9600);
    expect(q.rateSource).toBe("FIXTURE_EXAMPLE");
  });

  it("cross-currency KZT->EUR quote for a fixed target uses CEIL mid conversion with 55 bps markup plus the KZT fee", async () => {
    const q = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 240_000 });
    expect(q.sourceAmountMinor).toBeGreaterThan(0);
    expect(q.fee.markupBps).toBe(55);
    expect(q.fee.totalMinor).toBe(99_000);
    const expected =
      convertMinor(240_000, "EUR", "KZT", crossRate(FIXTURE_RATES.rates, "EUR", "KZT", 12), { markupBps: 55, rounding: "CEIL" }) + 99_000;
    expect(q.sourceAmountMinor).toBe(expected);
  });

  it("source-amount KZT->EUR quote yields a positive target below the mid-rate conversion", async () => {
    const q = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", sourceAmountMinor: 40_000_000 });
    expect(q.targetAmountMinor).toBeGreaterThan(0);
    // Both currencies have exponent 2, so minor units convert at the plain rate: 400000 KZT / 612.40 is about 653 EUR.
    expect(q.targetAmountMinor).toBeLessThan(40_000_000 / 612.4);
  });

  it("rejects a quote that gives both or neither amount", async () => {
    await expect(
      ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", sourceAmountMinor: 1, targetAmountMinor: 1 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR" })).rejects.toBeInstanceOf(BankError);
  });
});

describe("transfer state machine on the demo clock", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("starts in incoming_payment_waiting with no webhooks", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    expect(transfer.status).toBe("incoming_payment_waiting");
    expect(ctx.sink.sent).toHaveLength(0);
  });

  it("walks processing -> funds_converted -> outgoing_payment_sent one step at a time", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    const { bank, clock, sink } = ctx;

    await bank.fund(PROFILE, transfer.id);
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.kind).toBe("bank");
    const first = sentBodies(sink)[0]!;
    expect(first.data.current_state).toBe("processing");
    expect(first.data.previous_state).toBe("incoming_payment_waiting");
    expect(first.event_type).toBe("transfers#state-change");

    clock.advance(19_999);
    await bank.tick();
    expect((await bank.getTransfer(transfer.id)).status).toBe("processing");

    clock.advance(1);
    await bank.tick();
    expect((await bank.getTransfer(transfer.id)).status).toBe("funds_converted");

    clock.advance(STEP_MS);
    await bank.tick();
    const done = await bank.getTransfer(transfer.id);
    expect(done.status).toBe("outgoing_payment_sent");
    expect(done.history.map((h) => h.state)).toEqual([...TRANSFER_STATES]);

    expect(sentBodies(sink).map((b) => b.data.current_state)).toEqual(["processing", "funds_converted", "outgoing_payment_sent"]);

    clock.advance(STEP_MS * 10);
    const changed = await bank.tick();
    expect(changed).toBe(0);
    expect(sink.sent).toHaveLength(3);
  });

  it("a single tick after a large clock jump emits both remaining transitions in order with scheduled times", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    const { bank, clock, sink } = ctx;
    await bank.fund(PROFILE, transfer.id);
    const fundedAt = Date.parse((await bank.getTransfer(transfer.id)).fundedAt!);

    clock.advance(3 * 86_400_000);
    await bank.tick();

    const bodies = sentBodies(sink);
    expect(bodies.map((b) => b.data.current_state)).toEqual(["processing", "funds_converted", "outgoing_payment_sent"]);
    expect(bodies[1]!.data.occurred_at).toBe(new Date(fundedAt + STEP_MS).toISOString());
    expect(bodies[2]!.data.occurred_at).toBe(new Date(fundedAt + 2 * STEP_MS).toISOString());
    expect((await bank.getTransfer(transfer.id)).status).toBe("outgoing_payment_sent");
  });

  it("moving the demo clock backwards after funding does not revert the status", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    const { bank, clock, sink } = ctx;
    await bank.fund(PROFILE, transfer.id);

    clock.advance(-3_600_000);
    await bank.tick();

    expect((await bank.getTransfer(transfer.id)).status).toBe("processing");
    expect(sink.sent).toHaveLength(1);
  });
});

describe("funding and balances", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("debits the source balance by the source amount", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    await ctx.bank.fund(PROFILE, transfer.id);
    const [eur] = (await ctx.bank.listBalances(PROFILE)).filter((b) => b.currency === "EUR");
    expect(eur!.amount.valueMinor).toBe(30_000 - 9650);
  });

  it("rejects a second funding with 409 transfer.already_funded", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    await ctx.bank.fund(PROFILE, transfer.id);
    await expect(ctx.bank.fund(PROFILE, transfer.id)).rejects.toMatchObject({ status: 409, code: "transfer.already_funded" });
  });

  it("rejects funding with 422 transfer.insufficient_funds and leaves the balance unchanged", async () => {
    const quote = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 240_000 });
    const recipient = await recipientFor(ctx.bank);
    const { transfer } = await ctx.bank.createTransfer({
      targetAccount: recipient.id,
      quoteUuid: quote.id,
      customerTransactionId: randomUUID(),
      reference: "big",
    });
    expect(transfer.sourceAmountMinor).toBeGreaterThan(90_000_000);
    await expect(ctx.bank.fund(PROFILE, transfer.id)).rejects.toMatchObject({
      status: 422,
      code: "transfer.insufficient_funds",
    });
    const [kzt] = (await ctx.bank.listBalances(PROFILE)).filter((b) => b.currency === "KZT");
    expect(kzt!.amount.valueMinor).toBe(90_000_000);
    expect(ctx.sink.sent).toHaveLength(0);
  });

  it("reset() restores the seeded EUR balance", async () => {
    const { transfer } = await createFundableTransfer(ctx);
    await ctx.bank.fund(PROFILE, transfer.id);
    await ctx.bank.reset();
    const [eur] = (await ctx.bank.listBalances(PROFILE)).filter((b) => b.currency === "EUR");
    expect(eur!.amount.valueMinor).toBe(30_000);
  });
});

describe("transfer creation", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("is idempotent on customerTransactionId for the same quote and account", async () => {
    const quote = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 });
    const recipient = await recipientFor(ctx.bank);
    const customerTransactionId = randomUUID();
    const first = await ctx.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId, reference: "r" });
    const second = await ctx.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId, reference: "r" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transfer.id).toBe(first.transfer.id);
  });

  it("rejects a reused customerTransactionId with a different quote with 409", async () => {
    const q1 = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 });
    const q2 = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 });
    const recipient = await recipientFor(ctx.bank);
    const customerTransactionId = randomUUID();
    await ctx.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: q1.id, customerTransactionId, reference: "r" });
    await expect(
      ctx.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: q2.id, customerTransactionId, reference: "r" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an expired quote with 422 quote.expired", async () => {
    const quote = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 9600 });
    const recipient = await recipientFor(ctx.bank);
    ctx.clock.advance(31 * 60_000);
    await expect(
      ctx.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId: randomUUID(), reference: "r" }),
    ).rejects.toMatchObject({ status: 422, code: "quote.expired" });
  });
});

describe("recipients and profiles", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("rejects an IBAN with a wrong check digit with 422", async () => {
    const bad = IBAN.slice(0, -1) + (IBAN.endsWith("9") ? "8" : "9");
    const err = await recipientFor(ctx.bank, bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
    expect((err as BankError).status).toBe(422);
  });

  it("resolves the profile alias case-insensitively and throws 404 for unknown ids", async () => {
    expect(await ctx.bank.resolveProfile("C83D27E3-4E03-570F-8FEA-87DB32399C12")).toBe(PROFILE);
    const err = await ctx.bank.resolveProfile("999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
    expect((err as BankError).status).toBe(404);
  });
});

describe("(2026-10-18) conversions between a wallet's own balances (POST /v2/profiles/:p/balance-movements)", () => {
  let ctx: Ctx;
  const balance = async (currency: string) => (await ctx.bank.listBalances(PROFILE)).find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("KZT → EUR at a quote: the quote's source amount (fee and markup in it) leaves KZT, its target lands in EUR", async () => {
    const q = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 100_000, routeId: "kzt-mock-bank" });
    const m = await ctx.bank.convert(PROFILE, { quoteId: q.id, customerTransactionId: "p-1" });
    expect(m).toMatchObject({ type: "CONVERSION", state: "COMPLETED", sourceAmountMinor: q.sourceAmountMinor, targetAmountMinor: 100_000 });
    expect(await balance("KZT")).toBe(90_000_000 - q.sourceAmountMinor);
    expect(await balance("EUR")).toBe(130_000);
    // Same key again: the same movement, nothing moves twice.
    expect(await ctx.bank.convert(PROFILE, { quoteId: q.id, customerTransactionId: "p-1" })).toEqual(m);
    expect(await balance("EUR")).toBe(130_000);
    // The quote is spent: neither another conversion nor a transfer can use it.
    await expect(ctx.bank.convert(PROFILE, { quoteId: q.id, customerTransactionId: "p-2" })).rejects.toMatchObject({ status: 422, code: "quote.already_used" });
    const r = await recipientFor(ctx.bank);
    await expect(ctx.bank.createTransfer({ targetAccount: r.id, quoteUuid: q.id, customerTransactionId: "t-1", reference: "x" })).rejects.toMatchObject({ code: "quote.already_used" });
  });

  it("short of the source amount: 422 transfer.insufficient_funds and both balances unchanged; the key stays free", async () => {
    const q = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 200_000, routeId: "kzt-mock-bank" });
    await expect(ctx.bank.convert(PROFILE, { quoteId: q.id, customerTransactionId: "p-3" })).rejects.toMatchObject({ status: 422, code: "transfer.insufficient_funds" });
    expect(await balance("KZT")).toBe(90_000_000);
    expect(await balance("EUR")).toBe(30_000);
  });

  it("only this profile's quotes, between two currencies, and a key cannot be reused for another quote", async () => {
    const same = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 1_000 });
    await expect(ctx.bank.convert(PROFILE, { quoteId: same.id, customerTransactionId: "p-4" })).rejects.toBeInstanceOf(BankError);
    await expect(ctx.bank.convert(PROFILE, { quoteId: randomUUID(), customerTransactionId: "p-5" })).rejects.toMatchObject({ status: 404 });
    const a = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 1_000, routeId: "kzt-mock-bank" });
    const b = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "EUR", targetAmountMinor: 1_000, routeId: "kzt-mock-bank" });
    await ctx.bank.convert(PROFILE, { quoteId: a.id, customerTransactionId: "p-6" });
    await expect(ctx.bank.convert(PROFILE, { quoteId: b.id, customerTransactionId: "p-6" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("(2026-10-19) one-time card charges paid from the wallet (POST /bank/card-debits)", () => {
  let ctx: Ctx;
  const balance = async (currency: string) => (await ctx.bank.listBalances(PROFILE)).find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
  const charge = (over: Partial<{ authorizationId: string; cardId: string; amountMinor: number; currency: string }> = {}) =>
    ctx.bank.cardDebit(PROFILE, { authorizationId: "auth-1", cardId: "fic_1", amountMinor: 5_000, currency: "EUR", ...over });
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("same currency: the charge leaves that balance, nothing converts", async () => {
    const d = await charge();
    expect(d).toMatchObject({ created: true, amount: { valueMinor: 5_000, currency: "EUR" }, debited: { valueMinor: 5_000, currency: "EUR" }, balanceAfterMinor: 25_000 });
    expect(await balance("EUR")).toBe(25_000);
    expect(await balance("KZT")).toBe(90_000_000);
  });

  it("quotes beyond the demo currencies with the generic route (GBP into JPY and KWD: 0 and 3 decimals)", async () => {
    const jpy = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "GBP", targetCurrency: "JPY", targetAmountMinor: 10_000 });
    expect(jpy.sourceAmountMinor).toBe(convertMinor(10_000, "JPY", "GBP", crossRate(FIXTURE_RATES.rates, "JPY", "GBP", 12), { markupBps: 50, rounding: "CEIL" }));
    const kwd = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "KWD", targetAmountMinor: 12_345 });
    expect(kwd.sourceAmountMinor).toBeGreaterThan(0);
  });

  it("no balance in the card currency: the cheapest covering balance pays at the bank's own conversion price", async () => {
    // HUF 5,980.00: no HUF balance. EUR and KZT both cover it; EUR is cheaper at the mid rate.
    const q = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "EUR", targetCurrency: "HUF", targetAmountMinor: 598_000 });
    const k = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "HUF", targetAmountMinor: 598_000 });
    expect(convertMinor(q.sourceAmountMinor, "EUR", "HUF", q.midRate)).toBeLessThan(convertMinor(k.sourceAmountMinor, "KZT", "HUF", k.midRate));
    const d = await charge({ amountMinor: 598_000, currency: "HUF" });
    expect(d.debited).toEqual({ valueMinor: q.sourceAmountMinor, currency: "EUR" });
    // Mid conversion plus the route's 35 bps markup and EUR 0.50 fee, rounded up.
    expect(q.sourceAmountMinor).toBe(convertMinor(598_000, "HUF", "EUR", crossRate(FIXTURE_RATES.rates, "HUF", "EUR", 12), { markupBps: 35, rounding: "CEIL" }) + 50);
    expect(await balance("EUR")).toBe(30_000 - q.sourceAmountMinor);
    expect(await balance("HUF")).toBe(0);
    expect(await balance("KZT")).toBe(90_000_000);
  });

  it("the cheaper balance short: the next covering one pays (one balance, never split)", async () => {
    // HUF 196,250.00 = EUR 500 at mid: more than the EUR 300 balance, so KZT pays.
    const k = await ctx.bank.createQuote(PROFILE, { sourceCurrency: "KZT", targetCurrency: "HUF", targetAmountMinor: 19_625_000 });
    const d = await charge({ amountMinor: 19_625_000, currency: "HUF" });
    expect(d.debited).toEqual({ valueMinor: k.sourceAmountMinor, currency: "KZT" });
    expect(await balance("EUR")).toBe(30_000);
    expect(await balance("KZT")).toBe(90_000_000 - k.sourceAmountMinor);
  });

  it("no balance covers it: 422 transfer.insufficient_funds, nothing moves, and the authorization can be tried again", async () => {
    await expect(charge({ amountMinor: 50_000_000, currency: "USD" })).rejects.toMatchObject({ status: 422, code: "transfer.insufficient_funds" });
    expect(await balance("EUR")).toBe(30_000);
    expect(await balance("KZT")).toBe(90_000_000);
    expect(await charge({ amountMinor: 30_000 })).toMatchObject({ created: true, balanceAfterMinor: 0 });
    // The card currency's balance short: another balance pays the whole charge (KZT here), never part of it.
    expect((await charge({ authorizationId: "auth-2", cardId: "fic_2", amountMinor: 100 })).debited.currency).toBe("KZT");
    expect(await balance("EUR")).toBe(0);
  });

  it("idempotent per authorization; a single-use card is debited once", async () => {
    const first = await charge();
    // Replay of the same authorization: the recorded debit, no money moves.
    expect(await charge()).toEqual({ ...first, created: false });
    // Another authorization for the same charge on the same card (e.g. after a lost answer): still one debit.
    expect(await charge({ authorizationId: "auth-2" })).toMatchObject({ created: false, debited: first.debited, authorizationId: "auth-2" });
    expect(await balance("EUR")).toBe(25_000);
    // A different charge on the card, or the authorization id reused for another card: 409, nothing moves.
    await expect(charge({ authorizationId: "auth-3", amountMinor: 4_000 })).rejects.toMatchObject({ status: 409, code: "card_debit.conflict" });
    await expect(charge({ cardId: "fic_2" })).rejects.toMatchObject({ status: 409 });
    expect(await balance("EUR")).toBe(25_000);
  });

  it("concurrent replays of one authorization debit once", async () => {
    const all = await Promise.all([charge(), charge(), charge()]);
    expect(all.filter((d) => d.created)).toHaveLength(1);
    expect(await balance("EUR")).toBe(25_000);
  });

  it("reset() forgets card debits", async () => {
    await charge();
    await ctx.bank.reset();
    expect(await charge()).toMatchObject({ created: true });
  });
});
