/*
 * (added 2026-10-18) CONVERT rail: an exchange between the user's own wallet balances (spec §12 "Convert"), Wise's
 * balance conversion: a quote for the target amount from the signed funding currency (payOut BALANCE), then
 * POST /v2/profiles/:p/balance-movements with that quote. Nothing leaves the user's wallet profile.
 *
 * Payments-side checks before any money moves (same rules as the bank rail): the quote must buy exactly the signed
 * amount in the signed currency, from the signed funding currency, debiting no more than the signed maximum
 * (FUNDING_ABOVE_SIGNED_MAX); a balance short of the quote is INSUFFICIENT_FUNDS. The conversion is idempotent per
 * order (customerTransactionId = proposalId on the mock bank; X-idempotence-uuid on Wise).
 */
import { fromMinor, orderConversion, type CanonicalOrder, type PaymentStatus } from "@kassa/shared";

import { bankCall, bankMode } from "./bankApi.ts";
import { bankProfileFor, decimal, fundingShort, minorOf, normalizeQuote, shortOf } from "./mockBank.ts";
import type { ExecCtx, Rail, RailResult } from "./types.ts";

/** Wise balance movement (conversion) answer; the mock bank adds minor units. */
type BalanceMovement = {
  id?: string | number;
  state?: string;
  sourceAmount?: { value?: number | string; currency?: string };
  targetAmount?: { value?: number | string; currency?: string };
  sourceAmountMinor?: number;
  targetAmountMinor?: number;
  rate?: number | string;
};

function movementStatus(state: string | undefined): PaymentStatus {
  return state === "COMPLETED" ? "SENT" : state === "REJECTED" || state === "CANCELLED" ? "FAILED" : "PROCESSING";
}

export const convertRail: Rail = {
  id: "CONVERT",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    const c = orderConversion(order);
    if (!c) return { status: "FAILED", railRef: "convert:none", reasonCodes: ["RAIL_ERROR"], details: { error: "not a conversion order" } };
    const profile = await bankProfileFor(order.userId);
    const wiseMode = bankMode() === "wise-sandbox";
    const quote = normalizeQuote(
      await bankCall<Record<string, unknown>>("POST", `/v3/profiles/${profile}/quotes`, {
        sourceCurrency: c.fromCurrency,
        targetCurrency: c.toCurrency,
        targetAmount: decimal(c.amountMinor, c.toCurrency),
        payOut: "BALANCE",
        ...(wiseMode ? {} : { targetAmountMinor: c.amountMinor, routeId: c.routeId }),
      }),
    );
    if (quote.targetCurrency !== c.toCurrency || quote.targetAmountMinor !== c.amountMinor || quote.sourceCurrency !== c.fromCurrency) {
      return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["FUNDING_ABOVE_SIGNED_MAX"], details: { quoteId: quote.id, error: "quote does not match the signed conversion" } };
    }
    if (typeof quote.sourceAmountMinor !== "number" || quote.sourceAmountMinor > c.maxDebitMinor) {
      return {
        status: "FAILED",
        railRef: `quote:${quote.id}`,
        reasonCodes: ["FUNDING_ABOVE_SIGNED_MAX"],
        details: { quoteId: quote.id, quoteSourceAmountMinor: quote.sourceAmountMinor ?? null, signedMaxMinor: c.maxDebitMinor, fundingCurrency: c.fromCurrency },
      };
    }
    const short = await shortOf(order.userId, c.fromCurrency, quote.sourceAmountMinor);
    if (short) return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["INSUFFICIENT_FUNDS"], details: { quoteId: quote.id, sourceCurrency: c.fromCurrency, ...short } };

    let moved: BalanceMovement;
    try {
      moved = await bankCall<BalanceMovement>(
        "POST",
        `/v2/profiles/${profile}/balance-movements`,
        { quoteId: quote.id, ...(wiseMode ? {} : { customerTransactionId: order.proposalId }) },
        { "X-idempotence-uuid": order.proposalId },
      );
    } catch (err) {
      if (fundingShort(err)) {
        return { status: "FAILED", railRef: `quote:${quote.id}`, reasonCodes: ["INSUFFICIENT_FUNDS"], details: { quoteId: quote.id, sourceCurrency: c.fromCurrency, error: (err as Error).message } };
      }
      throw err;
    }
    const sourceAmountMinor = typeof moved.sourceAmountMinor === "number" ? moved.sourceAmountMinor : minorOf(moved.sourceAmount?.value, c.fromCurrency);
    const targetAmountMinor = typeof moved.targetAmountMinor === "number" ? moved.targetAmountMinor : minorOf(moved.targetAmount?.value, c.toCurrency);
    return {
      status: movementStatus(moved.state),
      railRef: `conversion:${String(moved.id ?? quote.id)}`,
      details: {
        bank: wiseMode ? "wise-sandbox" : "mock",
        kind: "CONVERSION",
        paymentId: ctx.paymentId,
        quoteId: quote.id,
        routeId: c.routeId,
        sourceCurrency: c.fromCurrency,
        sourceAmountMinor: sourceAmountMinor ?? quote.sourceAmountMinor,
        targetCurrency: c.toCurrency,
        targetAmountMinor: targetAmountMinor ?? c.amountMinor,
        signedMaxMinor: c.maxDebitMinor,
        rate: moved.rate !== undefined ? String(moved.rate) : null,
        targetAmount: fromMinor(c.amountMinor, c.toCurrency),
      },
    };
  },
};
