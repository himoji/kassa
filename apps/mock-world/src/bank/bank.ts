import { randomUUID } from "node:crypto";

import { convertMinor, crossRate, isSupportedCurrency, normalizeIban, parseRate, validatePayeeAccount, type PayeeAccountFields } from "@kassa/shared";

import type { Clock } from "../clock.ts";
import type { WebhookSink } from "../webhooks.ts";
import type { RailRoute, RateProvider } from "./rates.ts";
import { mockBankRoute } from "./rates.ts";

/*
 * Mock bank with Wise-shaped resources (spec §11, §17): quotes, recipient accounts, transfers,
 * balance funding and per-currency balances for Dana's capped wallet. In-memory only; resets on
 * restart and on POST /mock/reset.
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
 * Concurrency: every mutating method awaits the clock/rates first and then checks and mutates
 * synchronously, so two concurrent requests cannot both pass a check (Node runs one turn at a time).
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
  | { type: "aba"; abartn: string; accountNumber: string; accountType: "CHECKING" | "SAVINGS" };

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
  simulated: true;
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
function payeeFields(a: RecipientAccount): PayeeAccountFields {
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
}

export interface BankOptions {
  clock: Clock;
  rates: RateProvider;
  webhooks: WebhookSink;
  stepMs: number;
  /** `aliases`: other ids accepted for the same profile (e.g. the Kassa user UUID the API sends). */
  initialBalances: { profileId: number; aliases?: string[]; balances: { currency: string; amountMinor: number }[] }[];
  /** First id for accounts/transfers. Default derives from start time so ids do not repeat across restarts. */
  idStart?: number;
}

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
  private readonly byCustomerTxId = new Map<string, number>();
  private readonly quoteUsedBy = new Map<string, number>();
  private balances = new Map<number, Map<string, number>>();
  private readonly aliases = new Map<string, number>();
  private nextId: number;

  constructor(private readonly opts: BankOptions) {
    this.nextId = opts.idStart ?? 50_000_000 + (Math.floor(Date.now() / 1000) % 10_000_000) * 10;
    for (const p of opts.initialBalances) {
      this.aliases.set(String(p.profileId), p.profileId);
      for (const a of p.aliases ?? []) this.aliases.set(a.toLowerCase(), p.profileId);
    }
    this.resetBalances();
  }

  private resetBalances(): void {
    this.balances = new Map(
      this.opts.initialBalances.map((p) => [p.profileId, new Map(p.balances.map((b) => [b.currency, b.amountMinor]))]),
    );
  }

  /** Forget all quotes, recipients and transfers and restore seed balances. Ids keep increasing. */
  reset(): void {
    this.quotes.clear();
    this.recipients.clear();
    this.transfers.clear();
    this.byCustomerTxId.clear();
    this.quoteUsedBy.clear();
    this.resetBalances();
  }

  private wallet(profile: number): Map<string, number> {
    const w = this.balances.get(profile);
    if (!w) throw new BankError(404, "profile.not_found", `Unknown profile ${profile}`);
    return w;
  }

  /** Canonical numeric profile id for a path/body value (number, numeric string or alias). */
  resolveProfile(raw: string | number): number {
    const id = this.aliases.get(String(raw).toLowerCase());
    if (id === undefined) throw new BankError(404, "profile.not_found", `Unknown profile ${raw}`);
    return id;
  }

  // ---------- Quotes ----------

  async createQuote(profile: number, input: QuoteInput): Promise<Quote> {
    this.wallet(profile);
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
    const route: RailRoute | undefined = mockBankRoute(src, input.routeId);
    if (!route) throw new BankError(422, "NOT_VALID", `No mock bank route for ${src}${input.routeId ? ` (${input.routeId})` : ""}`, "routeId");

    const table = await this.opts.rates.getRates();
    const now = await this.opts.clock.now();
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

  getQuote(profile: number, id: string): Quote {
    const q = this.quotes.get(id);
    if (!q || q.profile !== profile) throw new BankError(404, "quote.not_found", `Unknown quote ${id}`);
    return q;
  }

  // ---------- Recipients ----------

  createRecipient(input: RecipientInput): Recipient {
    this.wallet(input.profile);
    if (!isSupportedCurrency(input.currency)) throw new BankError(422, "NOT_VALID", `Unsupported currency ${input.currency}`, "currency");
    const account: RecipientAccount = input.account ?? { type: "iban", iban: input.iban };
    // ISO 13616 + MOD 97-10 for IBANs, Luhn for UnionPay, the ABA checksum, and the currency each type pays out in.
    const problem = validatePayeeAccount(payeeFields(account), input.currency);
    if (problem) {
      const [message, path] = RECIPIENT_ERRORS[problem.code] ?? ["Account details are not valid", "details"];
      throw new BankError(422, "NOT_VALID", message, path);
    }
    const { type, ...fields } = account;
    const details = type === "iban" ? { iban: normalizeIban(account.iban) } : fields;
    const r: Recipient = {
      id: this.nextId++,
      profile: input.profile,
      accountHolderName: input.accountHolderName,
      type,
      currency: input.currency,
      country: account.type === "iban" ? normalizeIban(account.iban).slice(0, 2) : account.type === "aba" ? "US" : "CN",
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
    // From here on: synchronous checks + mutation.
    const existingId = this.byCustomerTxId.get(input.customerTransactionId);
    if (existingId !== undefined) {
      const t = this.transfers.get(existingId)!;
      if (t.quoteUuid !== input.quoteUuid || t.targetAccount !== input.targetAccount) {
        throw new BankError(409, "transfer.idempotency_conflict", "customerTransactionId already used for a different transfer");
      }
      return { transfer: t, created: false };
    }
    const quote = this.quotes.get(input.quoteUuid);
    if (!quote) throw new BankError(404, "quote.not_found", `Unknown quote ${input.quoteUuid}`, "quoteUuid");
    if (Date.parse(quote.expirationTime) <= now.getTime()) throw new BankError(422, "quote.expired", "Quote has expired", "quoteUuid");
    if (this.quoteUsedBy.has(quote.id)) throw new BankError(422, "quote.already_used", "Quote already used by another transfer", "quoteUuid");
    const account = this.recipients.get(input.targetAccount);
    if (!account) throw new BankError(404, "account.not_found", `Unknown account ${input.targetAccount}`, "targetAccount");
    if (account.profile !== quote.profile) throw new BankError(422, "NOT_VALID", "Account and quote belong to different profiles", "targetAccount");
    if (account.currency !== quote.targetCurrency) {
      throw new BankError(422, "NOT_VALID", "Account currency does not match the quote target currency", "targetAccount");
    }
    const t: Transfer = {
      id: this.nextId++,
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
      simulated: true,
    };
    quote.status = "ACCEPTED";
    this.transfers.set(t.id, t);
    this.byCustomerTxId.set(t.customerTransactionId, t.id);
    this.quoteUsedBy.set(quote.id, t.id);
    return { transfer: t, created: true };
  }

  /** POST /v3/profiles/:p/transfers/:id/payments {type: BALANCE}. */
  async fund(
    profile: number,
    transferId: number,
  ): Promise<{ type: "BALANCE"; status: "COMPLETED"; errorCode: null; balanceTransactionId: number }> {
    const now = await this.opts.clock.now();
    const t = this.transfers.get(transferId);
    if (!t || t.profile !== profile) throw new BankError(404, "transfer.not_found", `Unknown transfer ${transferId}`);
    if (t.fundedAt !== null || t.status !== "incoming_payment_waiting") {
      throw new BankError(409, "transfer.already_funded", "Transfer is already funded");
    }
    const wallet = this.wallet(profile);
    const available = wallet.get(t.sourceCurrency) ?? 0;
    if (available < t.sourceAmountMinor) {
      throw new BankError(422, "transfer.insufficient_funds", "Insufficient balance", undefined, {
        type: "BALANCE",
        status: "REJECTED",
        errorCode: "transfer.insufficient_funds",
      });
    }
    wallet.set(t.sourceCurrency, available - t.sourceAmountMinor);
    t.fundedAt = now.toISOString();
    this.transition(t, "processing", now.getTime());
    return { type: "BALANCE", status: "COMPLETED", errorCode: null, balanceTransactionId: this.nextId++ };
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
        this.transition(t, TRANSFER_STATES[idx]!, fundedAt + (idx - 1) * this.opts.stepMs);
        changed++;
      }
    }
    return changed;
  }

  private transition(t: Transfer, next: TransferState, atMs: number): void {
    const previous = t.status;
    const at = new Date(atMs).toISOString();
    t.status = next;
    t.history.push({ state: next, at });
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
    const wallet = this.wallet(profile);
    const now = (await this.opts.clock.now()).toISOString();
    return [...wallet.entries()].map(([currency, valueMinor], i) => ({
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
  credit(profile: number, currency: string, amountMinor: number): number {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new BankError(422, "NOT_VALID", "amountMinor must be a positive integer");
    if (!isSupportedCurrency(currency)) throw new BankError(422, "NOT_VALID", `Unsupported currency ${currency}`, "currency");
    const wallet = this.wallet(profile);
    const next = (wallet.get(currency) ?? 0) + amountMinor;
    if (!Number.isSafeInteger(next)) throw new BankError(422, "NOT_VALID", "Balance overflow");
    wallet.set(currency, next);
    return next;
  }
}
