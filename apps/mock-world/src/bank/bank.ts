import { randomUUID } from "node:crypto";

import { convertMinor, crossRate, isSupportedCurrency, normalizeIban, parseRate, validatePayeeAccount, type PayeeAccountFields } from "@kassa/shared";

import type { Clock } from "../clock.ts";
import { sameCardCharge, type BalanceStore, type CardDebitRecord, type SeedWallet } from "../store/types.ts";
import { type Collection, mapCollection } from "../store/sync.ts";
import type { WebhookSink } from "../webhooks.ts";
import type { RailRoute, RateProvider } from "./rates.ts";
import { mockBankRoute } from "./rates.ts";

/*
 * Mock bank with Wise-shaped resources (spec §11, §17): quotes, recipient accounts, transfers,
 * balance funding and per-currency balances for Dana's capped wallet. Balances live in a BalanceStore (memory
 * locally, Postgres on a deployed build, store/types.ts); quotes, recipients and transfers are plain maps that
 * store/sync.ts shares between instances. Reset by POST /mock/reset.
 *
 * Deviation from Wise's wire format, on purpose (spec §0 "integer minor units everywhere"): money
 * fields are `...Minor` integers instead of Wise's decimal `sourceAmount`/`value`. Rates stay
 * decimal strings. Resource names, ids (integers for accounts/transfers, UUIDs for quotes),
 * status names and the `transfers#state-change` webhook shape follow Wise's public API.
 *
 * Transfer state machine, driven by the DEMO clock:
 *   incoming_payment_waiting --fund--> processing (at fundedAt)
 *     --> funds_converted (fundedAt + step) --> outgoing_payment_sent (fundedAt + 2*step)
 * Each transition emits one signed webhook, in order, even if a clock jump crosses several.
 *
 * Concurrency: money moves through the store's atomic credit/debit (a debit only succeeds if the balance covers it,
 * across instances too). Transfer bookkeeping is checked and mutated without an await in between where it matters
 * (Node runs one turn at a time); across instances last writer wins per entity.
 */

export const TRANSFER_STATES = ["incoming_payment_waiting", "processing", "funds_converted", "outgoing_payment_sent"] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

const QUOTE_TTL_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export class BankError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface Quote {
  id: string;
  profile: number;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmountMinor: number;
  targetAmountMinor: number;
  rate: string;
  midRate: string;
  rateType: "FIXED";
  rateDate: string;
  rateSource: "API_FX" | "FIXTURE_EXAMPLE";
  createdTime: string;
  expirationTime: string;
  payIn: "BALANCE";
  payOut: "BANK_TRANSFER";
  routeId: string;
  fee: { totalMinor: number; currency: string; fixedMinor: number; markupBps: number };
  estimatedDelivery: string;
  status: "PENDING" | "ACCEPTED";
  simulated: true;
}

/**
 * Wise recipient types the mock pays out to: IBAN (SEPA and other IBAN countries), Alipay and UnionPay card (CNY),
 * ABA / ACH (USD). Field names are Wise's.
 */
export type RecipientAccount =
  | { type: "iban"; iban: string }
  | { type: "chinese_alipay"; accountNumber: string }
  | { type: "chinese_card"; cardNumber: string }
  | { type: "aba"; abartn: string; accountNumber: string; accountType: "CHECKING" | "SAVINGS" }
  /** Another wallet in this bank (a Kassa user paying a Kassa user): credited when the transfer is sent. */
  | { type: "kassa_wallet"; walletProfile: number };

export interface Recipient {
  id: number;
  profile: number;
  accountHolderName: string;
  type: RecipientAccount["type"];
  currency: string;
  country: string;
  details: { legalType: "PRIVATE" | "BUSINESS" } & Omit<RecipientAccount, "type">;
  active: true;
  simulated: true;
}

export interface Transfer {
  id: number;
  profile: number;
  user: number;
  targetAccount: number;
  sourceAccount: null;
  quoteUuid: string;
  status: TransferState;
  reference: string;
  rate: string;
  created: string;
  details: { reference: string };
  hasActiveIssues: false;
  sourceCurrency: string;
  sourceAmountMinor: number;
  targetCurrency: string;
  targetAmountMinor: number;
  feeMinor: number;
  customerTransactionId: string;
  fundedAt: string | null;
  history: { state: TransferState; at: string }[];
  /** Kassa extension: delivered as soon as funded (instant payout). */
  instant: boolean;
  simulated: true;
}

/** (added 2026-10-18) Wise balance movement of type CONVERSION (POST /v2/profiles/:p/balance-movements), minor units. */
export interface BalanceMovement {
  id: number;
  type: "CONVERSION";
  state: "COMPLETED";
  profile: number;
  quoteId: string;
  customerTransactionId: string;
  createdTime: string;
  sourceAmountMinor: number;
  targetAmountMinor: number;
  sourceAmount: { valueMinor: number; currency: string };
  targetAmount: { valueMinor: number; currency: string };
  rate: string;
  fee: { totalMinor: number; currency: string };
  simulated: true;
}

/** (2026-10-19) A card charge paid from the wallet (POST /bank/card-debits). */
export interface CardDebit {
  reference: string;
  authorizationId: string;
  cardId: string;
  profileId: number;
  /** The charge as the merchant sent it. */
  amount: { valueMinor: number; currency: string };
  /** What left the wallet: the funding balance, converted when its currency differs. */
  debited: { valueMinor: number; currency: string };
  balanceAfterMinor: number;
  /** false: a replay of a recorded debit (no money moved this time). */
  created: boolean;
  simulated: true;
}

function cardDebitView(d: CardDebitRecord, authorizationId: string, created: boolean): CardDebit {
  return {
    reference: d.reference,
    authorizationId,
    cardId: d.cardId,
    profileId: d.profile,
    amount: { valueMinor: d.requestAmountMinor, currency: d.requestCurrency },
    debited: { valueMinor: d.amountMinor, currency: d.currency },
    balanceAfterMinor: d.balanceAfterMinor,
    created,
    simulated: true,
  };
}

export interface QuoteInput {
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmountMinor?: number;
  targetAmountMinor?: number;
  routeId?: string;
}

export type RecipientInput = {
  currency: string;
  profile: number;
  accountHolderName: string;
  legalType: "PRIVATE" | "BUSINESS";
} & ({ iban: string; account?: undefined } | { account: RecipientAccount; iban?: undefined });

/** The shared payee-account fields for a Wise recipient, so the mock validates exactly what Kassa validates. */
function payeeFields(a: Exclude<RecipientAccount, { type: "kassa_wallet" }>): PayeeAccountFields {
  switch (a.type) {
    case "iban":
      return { scheme: "IBAN", iban: a.iban };
    case "chinese_alipay":
      return { scheme: "CN_ALIPAY", alipayId: a.accountNumber };
    case "chinese_card":
      return { scheme: "CN_UNIONPAY", cardNumber: a.cardNumber };
    case "aba":
      return { scheme: "US_ACH", routingNumber: a.abartn, accountNumber: a.accountNumber, accountType: a.accountType };
  }
}

const RECIPIENT_ERRORS: Record<string, [string, string]> = {
  IBAN_INVALID: ["IBAN is not valid", "details.iban"],
  ALIPAY_ID_INVALID: ["Alipay ID must be an email or a mainland China mobile number", "details.accountNumber"],
  UNIONPAY_CARD_INVALID: ["UnionPay card number is not valid", "details.cardNumber"],
  ACH_ROUTING_INVALID: ["ABA routing number is not valid", "details.abartn"],
  ACH_ACCOUNT_INVALID: ["Account number must be 4 to 17 digits", "details.accountNumber"],
  SCHEME_CURRENCY_MISMATCH: ["This recipient type cannot receive that currency", "currency"],
};

export interface TransferInput {
  targetAccount: number;
  quoteUuid: string;
  customerTransactionId: string;
  reference: string;
  instant?: boolean;
}

export interface BankOptions {
  clock: Clock;
  /** Instant payouts: a transfer created with `instant` is sent the moment it is funded. */
  instant?: boolean;
  rates: RateProvider;
  webhooks: WebhookSink;
  stepMs: number;
  /** Wallets, balances and ids (store/memory.ts or store/postgres.ts). */
  store: BalanceStore;
}

export type { SeedWallet };

/** units of `to` per unit of `from`, worsened by markup: mid / (1 + m). */
function effectiveRate(mid: string, markupBps: number, scale = 8): string {
  const r = parseRate(mid);
  const num = r.num * 10_000n * 10n ** BigInt(scale);
  const den = r.den * BigInt(10_000 + markupBps);
  const q = (num * 2n + den) / (2n * den); // round half up
  const s = q.toString().padStart(scale + 1, "0");
  const frac = s.slice(-scale).replace(/0+$/, "");
  return frac ? `${s.slice(0, -scale)}.${frac}` : s.slice(0, -scale);
}

export class MockBank {
  private readonly quotes = new Map<string, Quote>();
  private readonly recipients = new Map<number, Recipient>();
  private readonly transfers = new Map<number, Transfer>();
  /** (2026-10-18) Own-balance conversions by customerTransactionId (idempotency key; the API sends the proposal id). */
  private readonly conversions = new Map<string, BalanceMovement>();
  private readonly store: BalanceStore;
  /** Told about every transfer the moment it is paid out (the school portals match tuition payments this way). */
  private readonly payoutListeners: ((t: Transfer, account: Recipient | undefined) => void)[] = [];

  constructor(private readonly opts: BankOptions) {
    this.store = opts.store;
  }

  /** The maps store/sync.ts shares between instances. */
  collections(): Collection[] {
    return [
      mapCollection("bank.quote", this.quotes),
      mapCollection("bank.recipient", this.recipients, true),
      mapCollection("bank.transfer", this.transfers, true),
      mapCollection("bank.conversion", this.conversions),
    ];
  }

  onPayout(fn: (t: Transfer, account: Recipient | undefined) => void): void {
    this.payoutListeners.push(fn);
  }

  /** Forget quotes, recipients and transfers (this instance's copies; store/sync.ts handles the shared rows). */
  resetLocal(): void {
    this.quotes.clear();
    this.recipients.clear();
    this.transfers.clear();
    this.conversions.clear();
  }

  /** Forget all quotes, recipients and transfers and restore seed balances. Ids keep increasing. */
  async reset(): Promise<void> {
    this.resetLocal();
    await this.store.reset();
  }

  /**
   * Open an empty wallet for a new user under a given profile id (the API derives and stores it). Idempotent, so the
   * API can call it again any time.
   */
  async openWallet(profileId: number, aliases: string[] = []): Promise<{ profileId: number; created: boolean }> {
    if (!Number.isSafeInteger(profileId) || profileId <= 0) throw new BankError(422, "NOT_VALID", "profileId must be a positive integer", "profileId");
    const created = await this.store.openWallet(profileId, aliases);
    return { profileId, created };
  }

  /** Test money in (a simulated wallet tap or a Stripe test charge already made by the API). Idempotent by reference. */
  async topUp(profile: number, currency: string, amountMinor: number, reference: string): Promise<{ balanceAfterMinor: number; created: boolean }> {
    checkCredit(currency, amountMinor);
    const r = await this.store.topUp(reference, profile, currency, amountMinor);
    if (r.kind === "conflict") throw new BankError(409, "topup.idempotency_conflict", "reference already used for a different top-up", "reference");
    if (r.kind === "no_wallet") throw new BankError(404, "profile.not_found", `Unknown profile ${profile}`);
    return { balanceAfterMinor: r.balanceAfterMinor, created: r.created };
  }

  private async requireWallet(profile: number): Promise<void> {
    if (!(await this.store.hasWallet(profile))) throw new BankError(404, "profile.not_found", `Unknown profile ${profile}`);
  }

  /** Canonical numeric profile id for a path/body value (number, numeric string or alias). */
  async resolveProfile(raw: string | number): Promise<number> {
    const id = await this.store.resolve(String(raw));
    if (id === undefined) throw new BankError(404, "profile.not_found", `Unknown profile ${raw}`);
    return id;
  }

  // ---------- Quotes ----------

  async createQuote(profile: number, input: QuoteInput): Promise<Quote> {
    await this.requireWallet(profile);
    const { sourceCurrency: src, targetCurrency: tgt } = input;
    for (const [path, c] of [
      ["sourceCurrency", src],
      ["targetCurrency", tgt],
    ] as const) {
      if (!isSupportedCurrency(c)) throw new BankError(422, "NOT_VALID", `Unsupported currency ${c}`, path);
    }
    if ((input.sourceAmountMinor === undefined) === (input.targetAmountMinor === undefined)) {
      throw new BankError(422, "NOT_VALID", "Provide exactly one of sourceAmountMinor or targetAmountMinor", "sourceAmountMinor");
    }
    const now = await this.opts.clock.now();
    const { route, table, midRate, markupBps, feeMinor, sourceAmountMinor, targetAmountMinor } = await this.price(src, tgt, input);

    const quote: Quote = {
      id: randomUUID(),
      profile,
      sourceCurrency: src,
      targetCurrency: tgt,
      sourceAmountMinor,
      targetAmountMinor,
      rate: src === tgt ? "1" : effectiveRate(midRate, markupBps),
      midRate,
      rateType: "FIXED",
      rateDate: table.date,
      rateSource: table.source,
      createdTime: now.toISOString(),
      expirationTime: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
      payIn: "BALANCE",
      payOut: "BANK_TRANSFER",
      routeId: route.routeId,
      fee: { totalMinor: feeMinor, currency: src, fixedMinor: feeMinor, markupBps },
      estimatedDelivery: new Date(now.getTime() + route.settlementDays * DAY_MS).toISOString(),
      status: "PENDING",
      simulated: true,
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  /**
   * The bank's price for src → tgt on its own route for src (rails.json MOCK_BANK): mid-market rate from the rate
   * provider, the route's markup when the currencies differ, and its fixed fee in src. Exactly one of the amounts.
   */
  private async price(src: string, tgt: string, input: { sourceAmountMinor?: number | undefined; targetAmountMinor?: number | undefined; routeId?: string | undefined }) {
    const route: RailRoute | undefined = mockBankRoute(src, input.routeId);
    if (!route) throw new BankError(422, "NOT_VALID", `No mock bank route for ${src}${input.routeId ? ` (${input.routeId})` : ""}`, "routeId");
    const table = await this.opts.rates.getRates();
    for (const c of [src, tgt, route.feeCurrency]) {
      if (table.rates[c] === undefined) throw new BankError(422, "NOT_VALID", `No rate for ${c}`, "targetCurrency");
    }
    const markupBps = src === tgt ? 0 : route.markupBps;
    const midRate = crossRate(table.rates, src, tgt, 10);
    const feeMinor =
      route.feeCurrency === src
        ? route.feeFixedMinor
        : convertMinor(route.feeFixedMinor, route.feeCurrency, src, crossRate(table.rates, route.feeCurrency, src, 12), {
            rounding: "CEIL",
          });

    let sourceAmountMinor: number;
    let targetAmountMinor: number;
    if (input.targetAmountMinor !== undefined) {
      targetAmountMinor = input.targetAmountMinor;
      // The sender pays whatever guarantees the target amount: round the conversion up.
      sourceAmountMinor =
        convertMinor(targetAmountMinor, tgt, src, crossRate(table.rates, tgt, src, 12), { markupBps, rounding: "CEIL" }) + feeMinor;
    } else {
      sourceAmountMinor = input.sourceAmountMinor!;
      const net = sourceAmountMinor - feeMinor;
      if (net <= 0) throw new BankError(422, "NOT_VALID", "Amount does not cover the transfer fee", "sourceAmountMinor");
      targetAmountMinor = convertMinor(net, src, tgt, midRate, { markupBps, markupMode: "RECEIVE_LESS", rounding: "FLOOR" });
      if (targetAmountMinor <= 0) throw new BankError(422, "NOT_VALID", "Amount too small", "sourceAmountMinor");
    }
    return { route, table, midRate, markupBps, feeMinor, sourceAmountMinor, targetAmountMinor };
  }

  getQuote(profile: number, id: string): Quote {
    const q = this.quotes.get(id);
    if (!q || q.profile !== profile) throw new BankError(404, "quote.not_found", `Unknown quote ${id}`);
    return q;
  }

  // ---------- Recipients ----------

  async createRecipient(input: RecipientInput): Promise<Recipient> {
    await this.requireWallet(input.profile);
    if (!isSupportedCurrency(input.currency)) throw new BankError(422, "NOT_VALID", `Unsupported currency ${input.currency}`, "currency");
    const account: RecipientAccount = input.account ?? { type: "iban", iban: input.iban };
    if (account.type === "kassa_wallet") {
      if (!(await this.store.hasWallet(account.walletProfile))) throw new BankError(422, "NOT_VALID", "Unknown wallet", "details.walletProfile");
      if (account.walletProfile === input.profile) throw new BankError(422, "NOT_VALID", "A wallet cannot pay itself", "details.walletProfile");
    } else {
      // ISO 13616 + MOD 97-10 for IBANs, Luhn for UnionPay, the ABA checksum, and the currency each type pays out in.
      const problem = validatePayeeAccount(payeeFields(account), input.currency);
      if (problem) {
        const [message, path] = RECIPIENT_ERRORS[problem.code] ?? ["Account details are not valid", "details"];
        throw new BankError(422, "NOT_VALID", message, path);
      }
    }
    const { type, ...fields } = account;
    const details = type === "iban" ? { iban: normalizeIban(account.iban) } : fields;
    const r: Recipient = {
      id: await this.store.nextId(),
      profile: input.profile,
      accountHolderName: input.accountHolderName,
      type,
      currency: input.currency,
      country: account.type === "iban" ? normalizeIban(account.iban).slice(0, 2) : account.type === "aba" ? "US" : account.type === "kassa_wallet" ? "XX" : "CN",
      details: { legalType: input.legalType, ...details } as Recipient["details"],
      active: true,
      simulated: true,
    };
    this.recipients.set(r.id, r);
    return r;
  }

  getRecipient(id: number): Recipient {
    const r = this.recipients.get(id);
    if (!r) throw new BankError(404, "account.not_found", `Unknown account ${id}`);
    return r;
  }

  // ---------- Transfers ----------

  async createTransfer(input: TransferInput): Promise<{ transfer: Transfer; created: boolean }> {
    const now = await this.opts.clock.now();
    const id = await this.store.nextId();
    // From here on: synchronous checks + mutation.
    const existing = this.transferByCustomerTxId(input.customerTransactionId);
    if (existing) {
      const t = existing;
      if (t.quoteUuid !== input.quoteUuid || t.targetAccount !== input.targetAccount) {
        throw new BankError(409, "transfer.idempotency_conflict", "customerTransactionId already used for a different transfer");
      }
      return { transfer: t, created: false };
    }
    const quote = this.quotes.get(input.quoteUuid);
    if (!quote) throw new BankError(404, "quote.not_found", `Unknown quote ${input.quoteUuid}`, "quoteUuid");
    if (Date.parse(quote.expirationTime) <= now.getTime()) throw new BankError(422, "quote.expired", "Quote has expired", "quoteUuid");
    if (this.quoteUsed(quote.id)) throw new BankError(422, "quote.already_used", "Quote already used by another transfer", "quoteUuid");
    const account = this.recipients.get(input.targetAccount);
    if (!account) throw new BankError(404, "account.not_found", `Unknown account ${input.targetAccount}`, "targetAccount");
    if (account.profile !== quote.profile) throw new BankError(422, "NOT_VALID", "Account and quote belong to different profiles", "targetAccount");
    if (account.currency !== quote.targetCurrency) {
      throw new BankError(422, "NOT_VALID", "Account currency does not match the quote target currency", "targetAccount");
    }
    const t: Transfer = {
      id,
      profile: quote.profile,
      user: quote.profile,
      targetAccount: account.id,
      sourceAccount: null,
      quoteUuid: quote.id,
      status: "incoming_payment_waiting",
      reference: input.reference,
      rate: quote.rate,
      created: now.toISOString(),
      details: { reference: input.reference },
      hasActiveIssues: false,
      sourceCurrency: quote.sourceCurrency,
      sourceAmountMinor: quote.sourceAmountMinor,
      targetCurrency: quote.targetCurrency,
      targetAmountMinor: quote.targetAmountMinor,
      feeMinor: quote.fee.totalMinor,
      customerTransactionId: input.customerTransactionId,
      fundedAt: null,
      history: [{ state: "incoming_payment_waiting", at: now.toISOString() }],
      instant: input.instant === true && this.opts.instant === true,
      simulated: true,
    };
    quote.status = "ACCEPTED";
    this.transfers.set(t.id, t);
    return { transfer: t, created: true };
  }

  private transferByCustomerTxId(customerTransactionId: string): Transfer | undefined {
    return this.listTransfers().find((t) => t.customerTransactionId === customerTransactionId);
  }

  /** POST /v3/profiles/:p/transfers/:id/payments {type: BALANCE}. */
  async fund(
    profile: number,
    transferId: number,
  ): Promise<{ type: "BALANCE"; status: "COMPLETED"; errorCode: null; balanceTransactionId: number; transferState: TransferState }> {
    const now = await this.opts.clock.now();
    const t = this.transfers.get(transferId);
    if (!t || t.profile !== profile) throw new BankError(404, "transfer.not_found", `Unknown transfer ${transferId}`);
    if (t.fundedAt !== null || t.status !== "incoming_payment_waiting") {
      throw new BankError(409, "transfer.already_funded", "Transfer is already funded");
    }
    await this.requireWallet(profile);
    const balanceTransactionId = await this.store.nextId();
    // Claimed before the debit's await, so a concurrent fund call on this instance sees it as funded.
    t.fundedAt = now.toISOString();
    const after = await this.store.debit(profile, t.sourceCurrency, t.sourceAmountMinor);
    if (after === null) {
      t.fundedAt = null;
      throw new BankError(422, "transfer.insufficient_funds", "Insufficient balance", undefined, {
        type: "BALANCE",
        status: "REJECTED",
        errorCode: "transfer.insufficient_funds",
      });
    }
    await this.transition(t, "processing", now.getTime());
    if (t.instant) {
      // Instant payout: converted and sent at once (each state still gets its webhook, in order).
      await this.transition(t, "funds_converted", now.getTime());
      await this.transition(t, "outgoing_payment_sent", now.getTime());
    }
    return { type: "BALANCE", status: "COMPLETED", errorCode: null, balanceTransactionId, transferState: t.status };
  }

  /** A quote pays one transfer or converts once. */
  private quoteUsed(quoteId: string): boolean {
    return this.listTransfers().some((x) => x.quoteUuid === quoteId) || [...this.conversions.values()].some((c) => c.quoteId === quoteId);
  }

  // ---------- Conversions (own balance → own balance) ----------

  /**
   * (added 2026-10-18) Wise POST /v2/profiles/:p/balance-movements {quoteId}: convert between the profile's own
   * balances at one of its quotes. The quote's sourceAmountMinor (fee and markup included) leaves sourceCurrency through
   * the store's covers-checked debit, then its targetAmountMinor arrives in targetCurrency. Short of the source amount:
   * 422 transfer.insufficient_funds and nothing moves. A quote converts (or pays) once; idempotent per
   * customerTransactionId.
   */
  async convert(profile: number, input: { quoteId: string; customerTransactionId: string }): Promise<BalanceMovement> {
    const now = await this.opts.clock.now();
    const seen = this.conversions.get(input.customerTransactionId);
    if (seen) {
      if (seen.quoteId !== input.quoteId || seen.profile !== profile) {
        throw new BankError(409, "conversion.idempotency_conflict", "customerTransactionId already used for a different conversion", "customerTransactionId");
      }
      return seen;
    }
    const quote = this.quotes.get(input.quoteId);
    if (!quote || quote.profile !== profile) throw new BankError(404, "quote.not_found", `Unknown quote ${input.quoteId}`, "quoteId");
    if (Date.parse(quote.expirationTime) <= now.getTime()) throw new BankError(422, "quote.expired", "Quote has expired", "quoteId");
    if (this.quoteUsed(quote.id)) throw new BankError(422, "quote.already_used", "Quote already used", "quoteId");
    if (quote.sourceCurrency === quote.targetCurrency) throw new BankError(422, "NOT_VALID", "A conversion is between two currencies", "quoteId");
    await this.requireWallet(profile);
    const id = await this.store.nextId();
    const m: BalanceMovement = {
      id,
      type: "CONVERSION",
      state: "COMPLETED",
      profile,
      quoteId: quote.id,
      customerTransactionId: input.customerTransactionId,
      createdTime: now.toISOString(),
      sourceAmountMinor: quote.sourceAmountMinor,
      targetAmountMinor: quote.targetAmountMinor,
      sourceAmount: { valueMinor: quote.sourceAmountMinor, currency: quote.sourceCurrency },
      targetAmount: { valueMinor: quote.targetAmountMinor, currency: quote.targetCurrency },
      rate: quote.rate,
      fee: { totalMinor: quote.fee.totalMinor, currency: quote.fee.currency },
      simulated: true,
    };
    // Claimed before the debit's await (like fund()), so a concurrent call on this instance sees the quote as used.
    this.conversions.set(input.customerTransactionId, m);
    const after = await this.store.debit(profile, quote.sourceCurrency, quote.sourceAmountMinor);
    if (after === null) {
      this.conversions.delete(input.customerTransactionId);
      throw new BankError(422, "transfer.insufficient_funds", "Insufficient balance", undefined, { type: "BALANCE", status: "REJECTED", errorCode: "transfer.insufficient_funds" });
    }
    await this.store.credit(profile, quote.targetCurrency, quote.targetAmountMinor);
    quote.status = "ACCEPTED";
    return m;
  }

  // ---------- Card charges (one-time cards Kassa issued, paid from the wallet) ----------

  /**
   * (added 2026-10-19) Pay an approved one-time card charge from the profile's wallet. Called by Kassa's issuer
   * (POST /bank/card-debits) when it approves an authorization; the issuer approves only if this succeeds.
   *
   * Funding: the balance in the charge currency when it covers the charge. Otherwise the other balances that cover it
   * after conversion at the bank's own price (price(): mid rate, the route's markup and fixed fee, rounded up, as for
   * a balance conversion), cheapest at the mid rate first (funding.ts picks the cheapest covering route the same way),
   * wallet order on ties. One balance pays the whole charge; nothing is split. None covers it: 422
   * transfer.insufficient_funds and nothing moves.
   *
   * Idempotent per authorization (reference "card-auth:<authorizationId>"): a replay returns the recorded debit
   * (created false) without moving money again. A card is debited at most once: another authorization on the same card
   * for the same charge returns the recorded debit too, a different charge is 409 card_debit.conflict.
   */
  async cardDebit(profile: number, input: { authorizationId: string; cardId: string; amountMinor: number; currency: string }): Promise<CardDebit> {
    checkCredit(input.currency, input.amountMinor);
    await this.requireWallet(profile);
    const request = { reference: `card-auth:${input.authorizationId}`, cardId: input.cardId, profile, requestCurrency: input.currency, requestAmountMinor: input.amountMinor };
    const conflict = () => new BankError(409, "card_debit.conflict", "This authorization or card already paid a different charge", "authorizationId");
    const seen = await this.store.findCardDebit(request.reference, request.cardId);
    if (seen) {
      if (!sameCardCharge(seen, { ...request, currency: seen.currency, amountMinor: seen.amountMinor })) throw conflict();
      return cardDebitView(seen, input.authorizationId, false);
    }
    for (const c of await this.cardFunding(profile, input.currency, input.amountMinor)) {
      const r = await this.store.cardDebit({ ...request, currency: c.currency, amountMinor: c.amountMinor });
      if (r.kind === "ok") return cardDebitView(r.debit, input.authorizationId, r.created);
      if (r.kind === "conflict") throw conflict();
      // insufficient: the balance moved since it was read; try the next one.
    }
    throw new BankError(422, "transfer.insufficient_funds", "Insufficient balance", undefined, { type: "BALANCE", status: "REJECTED", errorCode: "transfer.insufficient_funds" });
  }

  /** Balances that cover the charge, in the order they are tried (see cardDebit). */
  private async cardFunding(profile: number, currency: string, amountMinor: number): Promise<{ currency: string; amountMinor: number }[]> {
    const wallet = (await this.store.balances(profile)) ?? [];
    const same = wallet.find(([c]) => c === currency);
    if (same && same[1] >= amountMinor) return [{ currency, amountMinor }];
    const converted: { currency: string; amountMinor: number; midValue: number; position: number }[] = [];
    for (const [i, [src, balance]] of wallet.entries()) {
      if (src === currency || balance <= 0) continue;
      let p: Awaited<ReturnType<MockBank["price"]>>;
      try {
        p = await this.price(src, currency, { targetAmountMinor: amountMinor });
      } catch (err) {
        if (err instanceof BankError) continue; // no route or no rate for this balance
        throw err;
      }
      if (p.sourceAmountMinor > balance) continue;
      // The debit's worth in the charge currency at the mid rate: the cost of paying from this balance.
      const midValue = convertMinor(p.sourceAmountMinor, src, currency, p.midRate);
      converted.push({ currency: src, amountMinor: p.sourceAmountMinor, midValue, position: i });
    }
    converted.sort((a, b) => a.midValue - b.midValue || a.position - b.position);
    return converted.map(({ currency: c, amountMinor: a }) => ({ currency: c, amountMinor: a }));
  }

  async getTransfer(id: number): Promise<Transfer> {
    await this.tick();
    const t = this.transfers.get(id);
    if (!t) throw new BankError(404, "transfer.not_found", `Unknown transfer ${id}`);
    return t;
  }

  listTransfers(): Transfer[] {
    return [...this.transfers.values()];
  }

  /** Advance every funded transfer to where the demo clock says it should be. */
  async tick(): Promise<number> {
    const now = (await this.opts.clock.now()).getTime();
    let changed = 0;
    for (const t of this.transfers.values()) {
      if (t.fundedAt === null) continue;
      const fundedAt = Date.parse(t.fundedAt);
      const elapsedSteps = Math.floor((now - fundedAt) / this.opts.stepMs);
      // processing is index 1 (at fundedAt); each step moves one state further.
      const target = Math.min(TRANSFER_STATES.length - 1, 1 + Math.max(0, elapsedSteps));
      let idx = TRANSFER_STATES.indexOf(t.status);
      while (idx < target) {
        idx++;
        // The transition "happened" at its scheduled demo time, not when we noticed it.
        await this.transition(t, TRANSFER_STATES[idx]!, fundedAt + (idx - 1) * this.opts.stepMs);
        changed++;
      }
    }
    return changed;
  }

  private async transition(t: Transfer, next: TransferState, atMs: number): Promise<void> {
    const previous = t.status;
    const at = new Date(atMs).toISOString();
    t.status = next;
    t.history.push({ state: next, at });
    const account = this.recipients.get(t.targetAccount);
    if (next === "outgoing_payment_sent" && account?.type === "kassa_wallet") await this.deliverToWallet(t, account, at);
    // Wise `transfers#state-change` (schema 2.0.0) plus a `kassa` block with minor-unit details.
    this.opts.webhooks.send("bank", {
      data: {
        resource: { type: "transfer", id: t.id, profile_id: t.profile, account_id: t.targetAccount },
        current_state: next,
        previous_state: previous,
        occurred_at: at,
      },
      subscription_id: "kassa-mock-bank",
      event_type: "transfers#state-change",
      schema_version: "2.0.0",
      sent_at: at,
      kassa: {
        customerTransactionId: t.customerTransactionId,
        reference: t.reference,
        sourceCurrency: t.sourceCurrency,
        sourceAmountMinor: t.sourceAmountMinor,
        targetCurrency: t.targetCurrency,
        targetAmountMinor: t.targetAmountMinor,
        simulated: true,
      },
    });
    // After the bank's own webhook, so Kassa sees the payment SENT before a payee's system reports it received.
    if (next === "outgoing_payment_sent") {
      for (const fn of this.payoutListeners) {
        try {
          fn(t, account);
        } catch {
          // a listener's failure never undoes the payout
        }
      }
    }
  }

  /** Kassa → Kassa: the money lands in the other wallet, and its owner is told (remittance webhook, wallet.received). */
  private async deliverToWallet(t: Transfer, account: Recipient, at: string): Promise<void> {
    const target = (account.details as unknown as { walletProfile: number }).walletProfile;
    const balanceAfterMinor = await this.credit(target, t.targetCurrency, t.targetAmountMinor);
    this.opts.webhooks.send("remittance", {
      eventId: randomUUID(),
      type: "wallet.received",
      profileId: target,
      sourceProfileId: t.profile,
      transferId: t.id,
      amountMinor: t.targetAmountMinor,
      currency: t.targetCurrency,
      reference: t.reference,
      receivedAt: at,
      balanceAfterMinor,
      simulated: true,
    });
  }

  // ---------- Balances ----------

  async listBalances(profile: number): Promise<
    {
      id: number;
      currency: string;
      type: "STANDARD";
      amount: { valueMinor: number; currency: string };
      reservedAmount: { valueMinor: number; currency: string };
      totalWorth: { valueMinor: number; currency: string };
      modificationTime: string;
      visible: true;
      simulated: true;
    }[]
  > {
    const wallet = await this.store.balances(profile);
    if (!wallet) throw new BankError(404, "profile.not_found", `Unknown profile ${profile}`);
    const now = (await this.opts.clock.now()).toISOString();
    return wallet.map(([currency, valueMinor], i) => ({
      id: profile * 100 + i,
      currency,
      type: "STANDARD" as const,
      amount: { valueMinor, currency },
      reservedAmount: { valueMinor: 0, currency },
      totalWorth: { valueMinor, currency },
      modificationTime: now,
      visible: true as const,
      simulated: true as const,
    }));
  }

  /** Incoming money (remittance from home). Returns the new balance. */
  async credit(profile: number, currency: string, amountMinor: number): Promise<number> {
    checkCredit(currency, amountMinor);
    const next = await this.store.credit(profile, currency, amountMinor);
    if (next === null) throw new BankError(404, "profile.not_found", `Unknown profile ${profile}`);
    if (!Number.isSafeInteger(next)) throw new BankError(422, "NOT_VALID", "Balance overflow");
    return next;
  }
}

function checkCredit(currency: string, amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new BankError(422, "NOT_VALID", "amountMinor must be a positive integer");
  if (!isSupportedCurrency(currency)) throw new BankError(422, "NOT_VALID", `Unsupported currency ${currency}`, "currency");
}
