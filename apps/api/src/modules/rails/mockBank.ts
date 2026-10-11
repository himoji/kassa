/*
 * Mock bank rail (spec §11): a client for mock-world's Wise-shaped API. Route shapes mirror Wise's
 * public API (quotes v3, recipient accounts v1, transfers v1, fund v3, balances v4); amounts on the
 * wire are decimal major units as in Wise, converted with @kassa/shared toMinor/fromMinor (never floats
 * in our own maths). Status changes arrive as HMAC webhooks (POST /api/webhooks/mock/bank) and are also
 * polled by the scheduler.
 */
import { fromMinor, isSupportedCurrency, toMinor, type CanonicalOrder, type PaymentStatus } from "@kassa/shared";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { profiles } from "../../db/schema.ts";
import { looksLikeIban } from "../screening/iban.ts";
import { mockWorld } from "./http.ts";
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

function decimal(amountMinor: number, currency: string): number {
  return Number(fromMinor(amountMinor, currency));
}

/** Wise profile ids are integers; the user's capped-wallet profile is stored on profiles.bankProfileId. */
export async function bankProfileFor(userId: string): Promise<number> {
  const p = (await getDb().select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, userId)))[0];
  if (!p?.id) throw new Error("no mock bank profile for this user (seed sets profiles.bank_profile_id)");
  return p.id;
}

export const mockBankRail: Rail = {
  id: "BANK_TRANSFER",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    const profile = await bankProfileFor(order.userId);
    const legalType = ctx.payee.kind === "PERSON" || ctx.payee.kind === "OWN_ACCOUNT" ? "PRIVATE" : "BUSINESS";
    // Field names follow Wise (decimal amounts, nested details) plus the minor-unit / flat variants the
    // mock accepts; the mock ignores what it does not need.
    const quote = await mockWorld<{ id: string }>("POST", `/v3/profiles/${profile}/quotes`, {
      sourceCurrency: order.currency,
      targetCurrency: order.currency,
      targetAmount: decimal(order.amountMinor, order.currency),
      targetAmountMinor: order.amountMinor,
      payOut: "BANK_TRANSFER",
    });
    const recipient = await mockWorld<{ id: string | number }>("POST", `/v1/accounts`, {
      profile,
      currency: order.currency,
      type: looksLikeIban(ctx.payee.account) ? "iban" : "account",
      accountHolderName: order.payeeName,
      legalType,
      iban: ctx.payee.account,
      details: { iban: ctx.payee.account, legalType },
    });
    const reference = order.purpose.slice(0, 35);
    const transfer = await mockWorld<{ id: string | number; status?: string }>("POST", `/v1/transfers`, {
      targetAccount: recipient.id,
      quoteUuid: quote.id,
      // Idempotency key (Wise customerTransactionId): one transfer per proposal.
      customerTransactionId: order.proposalId,
      reference,
      details: { reference },
    });
    const funded = await mockWorld<{ status?: string }>("POST", `/v3/profiles/${profile}/transfers/${transfer.id}/payments`, {
      type: "BALANCE",
    });
    // Funding moves the transfer out of incoming_payment_waiting; later states arrive by webhook/poll.
    const status = mapWiseStatus(funded.status === "REJECTED" ? "cancelled" : (transfer.status ?? "processing"));
    return { status, railRef: String(transfer.id), details: { quoteId: quote.id, recipientId: recipient.id } };
  },
};

export async function getTransferStatus(transferId: string): Promise<PaymentStatus> {
  const t = await mockWorld<{ status: string }>("GET", `/v1/transfers/${transferId}`);
  return mapWiseStatus(t.status);
}

export type WalletBalances = { currency: string; amountMinor: number }[];

/** Capped-wallet balances per currency (GET /v4/profiles/:p/balances). */
export async function getWalletBalances(userId: string): Promise<WalletBalances> {
  const profile = await bankProfileFor(userId);
  const raw = await mockWorld<unknown>("GET", `/v4/profiles/${profile}/balances?types=STANDARD`);
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
      try {
        // Wise sends decimal numbers; round to the currency exponent before converting.
        minor = toMinor(Number(amount.value).toFixed(2), currency);
      } catch {
        minor = null;
      }
    }
    if (minor !== null) out.push({ currency, amountMinor: minor });
  }
  return out;
}
