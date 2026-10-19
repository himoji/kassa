/*
 * Bank rail (spec §11): a Wise API client. By default it talks to mock-world's Wise-shaped bank; with
 * WISE_SANDBOX_TOKEN it talks to Wise's own sandbox (rails/bankApi.ts). Route shapes are Wise's (quotes v3,
 * recipient accounts v1, transfers v1, fund v3, balances v4); amounts on the wire are decimal major units as in
 * Wise, converted with @kassa/shared toMinor/fromMinor (never floats in our own maths). Recipients follow the
 * payee's payout scheme (shared/payeeAccount.ts): IBAN (SEPA and other IBAN countries), Alipay and UnionPay (CNY),
 * ACH (USD). Mock status changes arrive as HMAC webhooks (POST /api/webhooks/mock/bank); both are also polled by
 * the scheduler.
 */
import { currencyExponent, decodePayeeAccount, fromMinor, normalizeKassaId, isSupportedCurrency, orderFunding, toMinor, type CanonicalOrder, type PaymentStatus } from "@kassa/shared";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { profiles } from "../../db/schema.ts";
import { ensureWalletProfile, userByKassaId } from "../wallet/service.ts";
import { bankCall, bankMode, simulateNextWiseState, WiseError, wiseSandboxProfile } from "./bankApi.ts";
import { MockWorldError } from "./http.ts";
import type { ExecCtx, Rail, RailResult } from "./types.ts";

/** Wise transfer states → our PaymentStatus (ISO 20022 pain.002 semantics: ACSP→PROCESSING, ACSC→SENT). */
export function mapWiseStatus(status: string): PaymentStatus {
  switch (status) {
    case "outgoing_payment_sent":
      return "SENT";
    case "cancelled":
      return "CANCELED";
    case "funds_refunded":
    case "bounced_back":
    case "charged_back":
      return "FAILED";
    case "incoming_payment_waiting":
    case "processing":
    case "funds_converted":
    default:
      return "PROCESSING";
  }
}

export function decimal(amountMinor: number, currency: string): number {
  return Number(fromMinor(amountMinor, currency));
}

/** Wise decimal (number or string) → minor units, rounded to the currency exponent first; null if absent. */
export function minorOf(value: unknown, currency: string): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  try {
    return toMinor(n.toFixed(currencyExponent(currency)), currency);
  } catch {
    return null;
  }
}

/** Wise legal types: people (and the user's own accounts) are PRIVATE, everyone else BUSINESS. */
type LegalType = "PRIVATE" | "BUSINESS";

/**
 * The Wise recipient (POST /v1/accounts) for a payee account, by payout scheme. Null when the account is not one a
 * bank transfer can reach (a merchant id kept for QR handoffs).
 */
export function wiseRecipientFor(account: string, opts: { profile: number; currency: string; holder: string; legalType: LegalType }): Record<string, unknown> | null {
  const base = { profile: opts.profile, currency: opts.currency, accountHolderName: opts.holder };
  const f = decodePayeeAccount(account);
  switch (f.scheme) {
    case "IBAN":
      return { ...base, type: "iban", details: { legalType: opts.legalType, iban: f.iban } };
    case "CN_ALIPAY":
      return { ...base, type: "chinese_alipay", details: { legalType: opts.legalType, accountNumber: f.alipayId } };
    case "CN_UNIONPAY":
      return { ...base, type: "chinese_card", details: { legalType: opts.legalType, cardNumber: f.cardNumber } };
    case "US_ACH":
      return { ...base, type: "aba", details: { legalType: opts.legalType, abartn: f.routingNumber, accountNumber: f.accountNumber, accountType: f.accountType } };
    case "KASSA_USER":
    case "OTHER":
      // Kassa users are paid wallet to wallet (kassaWalletRecipient); other identifiers cannot be reached.
      return null;
  }
}

/** Kassa → Kassa: the recipient is the other user's wallet in the sandbox bank (mock bank only). */
async function kassaWalletRecipient(account: string, opts: { profile: number; currency: string; holder: string; legalType: LegalType }): Promise<Record<string, unknown> | string> {
  const f = decodePayeeAccount(account);
  if (f.scheme !== "KASSA_USER") return "not a Kassa ID";
  if (bankMode() !== "mock") return "Kassa-to-Kassa payments run on the sandbox bank (mock-world), not on the Wise sandbox";
  const target = await userByKassaId(normalizeKassaId(f.kassaId) ?? "");
  if (!target) return "no Kassa user has this ID any more";
  const walletProfile = await ensureWalletProfile(target.id);
  return { profile: opts.profile, currency: opts.currency, accountHolderName: opts.holder, type: "kassa_wallet", details: { legalType: opts.legalType, walletProfile } };
}

type Quote = { id: string; sourceCurrency?: string; targetCurrency?: string; sourceAmountMinor?: number; targetAmountMinor?: number };

/** Wise's quote has decimal amounts, per pay-in option; the mock also returns minor units. One shape for the checks. */
export function normalizeQuote(raw: Record<string, unknown>): Quote {
  const src = String(raw.sourceCurrency ?? "");
  const tgt = String(raw.targetCurrency ?? "");
  const options = Array.isArray(raw.paymentOptions) ? (raw.paymentOptions as Record<string, unknown>[]) : [];
  const balance = options.find((o) => o.payIn === "BALANCE" && o.disabled !== true) ?? options.find((o) => o.disabled !== true);
  const sourceAmountMinor = typeof raw.sourceAmountMinor === "number" ? raw.sourceAmountMinor : minorOf(balance?.sourceAmount ?? raw.sourceAmount, src);
  const targetAmountMinor = typeof raw.targetAmountMinor === "number" ? raw.targetAmountMinor : minorOf(balance?.targetAmount ?? raw.targetAmount, tgt);
  return {
    id: String(raw.id),
    sourceCurrency: src,
    targetCurrency: tgt,
    ...(sourceAmountMinor !== null ? { sourceAmountMinor } : {}),
    ...(targetAmountMinor !== null ? { targetAmountMinor } : {}),
  };
}

/** Wise profile ids are integers; the user's capped-wallet profile is stored on profiles.bankProfileId. */
export async function bankProfileFor(userId: string): Promise<number> {
  if (bankMode() === "wise-sandbox") return wiseSandboxProfile();
  const p = (await getDb().select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, userId)))[0];
  if (!p?.id) throw new Error("no mock bank profile for this user (seed sets profiles.bank_profile_id)");
  return p.id;
}

/** The balance in `currency` is below `neededMinor` (known balances only; null when it covers it or cannot be read). */
export async function shortOf(userId: string, currency: string, neededMinor: number | undefined): Promise<{ balanceMinor: number; neededMinor: number } | null> {
  if (typeof neededMinor !== "number") return null;
  let balances: WalletBalances;
  try {
    balances = await getWalletBalances(userId);
  } catch {
    return null;
  }
  const balanceMinor = balances.find((b) => b.currency === currency)?.amountMinor ?? 0;
  return balanceMinor < neededMinor ? { balanceMinor, neededMinor } : null;
}

/** A funding call the bank refused for insufficient balance (mock bank 422 / Wise transfer.insufficient_funds). */
export function fundingShort(err: unknown): boolean {
  if (err instanceof WiseError) return err.code === "transfer.insufficient_funds" || err.status === 422;
  return err instanceof MockWorldError && err.status === 422;
}

export const mockBankRail: Rail = {
  id: "BANK_TRANSFER",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    const profile = await bankProfileFor(order.userId);
    const legalType = ctx.payee.kind === "PERSON" || ctx.payee.kind === "OWN_ACCOUNT" ? "PRIVATE" : "BUSINESS";
    // B2: the signed funding binding decides which balance pays (spec §12). Orders signed before the binding
    // existed (no funding fields) keep the old same-currency behaviour.
    const funding = orderFunding(order);
    const sourceCurrency = funding?.currency ?? order.currency;
    // Wise's fields (decimal targetAmount); the mock also reads the minor-unit amount and the signed route.
    const wiseMode = bankMode() === "wise-sandbox";
    const quote = normalizeQuote(
      await bankCall<Record<string, unknown>>("POST", `/v3/profiles/${profile}/quotes`, {
        sourceCurrency,
        targetCurrency: order.currency,
        targetAmount: decimal(order.amountMinor, order.currency),
        payOut: "BANK_TRANSFER",
        ...(wiseMode ? {} : { targetAmountMinor: order.amountMinor, ...(funding ? { routeId: funding.routeId } : {}) }),
      }),
    );
    // Payments-side check before any money moves (no transfer is created on failure): the quote must deliver
    // exactly the signed amount and debit no more than the signed maximum from the signed funding currency.
    if (quote.targetCurrency !== order.currency || quote.targetAmountMinor !== order.amountMinor || quote.sourceCurrency !== sourceCurrency) {
      return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["FUNDING_ABOVE_SIGNED_MAX"], details: { quoteId: quote.id, error: "quote does not match the signed order" } };
    }
    if (funding && (typeof quote.sourceAmountMinor !== "number" || quote.sourceAmountMinor > funding.maxAmountMinor)) {
      return {
        status: "FAILED",
        railRef: `quote:${quote.id}`,
        reasonCodes: ["FUNDING_ABOVE_SIGNED_MAX"],
        details: { quoteId: quote.id, quoteSourceAmountMinor: quote.sourceAmountMinor ?? null, signedMaxMinor: funding.maxAmountMinor, fundingCurrency: funding.currency },
      };
    }
    // (2026-10-18) The balance the quote debits must be there before a transfer is created: a short balance is
    // INSUFFICIENT_FUNDS (plain to the user), not an opaque RAIL_ERROR from the bank's funding call. An unreadable
    // balance leaves the bank's own funds check as the backstop (mapped the same way below).
    const short = await shortOf(order.userId, sourceCurrency, quote.sourceAmountMinor);
    if (short) {
      return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["INSUFFICIENT_FUNDS"], details: { quoteId: quote.id, sourceCurrency, ...short } };
    }
    const recipientOpts = { profile, currency: order.currency, holder: order.payeeName, legalType: legalType as LegalType };
    const kassa = decodePayeeAccount(ctx.payee.account).scheme === "KASSA_USER" ? await kassaWalletRecipient(ctx.payee.account, recipientOpts) : null;
    if (typeof kassa === "string") {
      return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["RAIL_ERROR"], details: { quoteId: quote.id, error: kassa } };
    }
    const recipientBody = kassa ?? wiseRecipientFor(ctx.payee.account, recipientOpts);
    if (!recipientBody) {
      return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["RAIL_ERROR"], details: { quoteId: quote.id, error: "this payee has no bank, Alipay, UnionPay, ACH or Kassa account a transfer can reach" } };
    }
    let recipient: { id: string | number };
    try {
      recipient = await bankCall<{ id: string | number }>("POST", `/v1/accounts`, recipientBody);
    } catch (err) {
      // Wise validates recipient fields itself (e.g. a US address for ACH): say which field it refused.
      if (err instanceof WiseError && err.status === 422) {
        return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["RAIL_ERROR"], details: { quoteId: quote.id, error: err.message, field: err.path ?? null } };
      }
      throw err;
    }
    const reference = order.purpose.slice(0, 35);
    const transfer = await bankCall<{ id: string | number; status?: string }>("POST", `/v1/transfers`, {
      targetAccount: recipient.id,
      quoteUuid: quote.id,
      // Idempotency key (Wise customerTransactionId): one transfer per proposal.
      customerTransactionId: order.proposalId,
      details: { reference },
      // Mock bank extension: pay out the moment it is funded when the bank runs instant payouts (fast send).
      ...(wiseMode ? {} : { instant: true }),
    });
    let funded: { status?: string; simulated?: boolean; transferState?: string };
    try {
      funded = await bankCall<{ status?: string; transferState?: string }>("POST", `/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: "BALANCE" });
    } catch (err) {
      // The bank refused funding for want of money (mock bank: 422 transfer.insufficient_funds): nothing was debited.
      if (fundingShort(err)) {
        return { status: "FAILED", railRef: String(transfer.id), reasonCodes: ["INSUFFICIENT_FUNDS"], details: { quoteId: quote.id, transferId: transfer.id, sourceCurrency, sourceAmountMinor: quote.sourceAmountMinor ?? null, error: (err as Error).message } };
      }
      // Wise refuses balance funding with a personal token for EU/UK profiles (PSD2 SCA, HTTP 403). In the sandbox
      // nothing real moves either way, so the transfer is moved on with the sandbox's own simulation instead.
      if (!(wiseMode && err instanceof WiseError && err.status === 403)) throw err;
      await simulateNextWiseState(String(transfer.id), transfer.status ?? "incoming_payment_waiting");
      funded = { status: "COMPLETED", simulated: true };
    }
    // Funding moves the transfer out of incoming_payment_waiting; later states arrive by webhook/poll. An instant
    // payout (mock bank) reports its state right in the funding answer: delivered already.
    const instantSent = !wiseMode && funded.transferState === "outgoing_payment_sent";
    const status = instantSent ? "SENT" : mapWiseStatus(funded.status === "REJECTED" ? "cancelled" : (transfer.status ?? "processing"));
    return {
      status,
      railRef: String(transfer.id),
      // bankState: last Wise state Kassa saw (webhooks/routes.ts refuses later states before funding, I13 / S9).
      details: { bank: wiseMode ? "wise-sandbox" : "mock", ...(funded.simulated ? { fundedBy: "sandbox-simulation" } : {}), quoteId: quote.id, recipientId: recipient.id, recipientType: recipientBody.type, ...(instantSent ? { instantPayout: true } : {}), bankState: instantSent ? "outgoing_payment_sent" : funded.status === "COMPLETED" ? "processing" : (transfer.status ?? "incoming_payment_waiting"), sourceCurrency, sourceAmountMinor: quote.sourceAmountMinor ?? null, ...(funding ? { signedMaxMinor: funding.maxAmountMinor } : {}) },
    };
  },
};

export async function getTransferStatus(transferId: string): Promise<PaymentStatus> {
  const t = await bankCall<{ status: string }>("GET", `/v1/transfers/${transferId}`);
  // The Wise sandbox never moves a transfer by itself: each poll steps it on (simulation endpoints).
  if (bankMode() === "wise-sandbox") {
    const next = await simulateNextWiseState(transferId, t.status);
    if (next) return mapWiseStatus(next);
  }
  return mapWiseStatus(t.status);
}

export type WalletBalances = { currency: string; amountMinor: number }[];

/** Capped-wallet balances per currency (GET /v4/profiles/:p/balances). */
export async function getWalletBalances(userId: string): Promise<WalletBalances> {
  const profile = await bankProfileFor(userId);
  const raw = await bankCall<unknown>("GET", `/v4/profiles/${profile}/balances?types=STANDARD`);
  const arr = Array.isArray(raw) ? raw : ((raw as { balances?: unknown[] })?.balances ?? []);
  const out: WalletBalances = [];
  for (const b of arr as Record<string, unknown>[]) {
    const amount = (b.amount ?? {}) as Record<string, unknown>;
    const currency = String(b.currency ?? amount.currency ?? "");
    if (!isSupportedCurrency(currency)) continue;
    let minor: number | null = null;
    if (typeof b.amountMinor === "number") minor = b.amountMinor;
    else if (typeof amount.valueMinor === "number") minor = amount.valueMinor;
    else if (typeof amount.value === "number" || typeof amount.value === "string") {
      // Wise sends decimal numbers; rounded to the currency exponent before converting.
      minor = minorOf(amount.value, currency);
    }
    if (minor !== null) out.push({ currency, amountMinor: minor });
  }
  return out;
}
