import { z } from "zod";

import { jcsHash } from "./jcs.ts";

// Spec §7, verbatim, plus the optional funding binding below. Changing an existing field changes every
// orderHash: bump `v`. Adding an OPTIONAL field is v-compatible: an order without it has exactly the
// same JCS bytes (and hash) as before (golden vector v1 in test/order.test.ts).
export const CanonicalOrder = z.object({
  v: z.literal(1),
  proposalId: z.string().uuid(),
  userId: z.string().uuid(),
  payeeId: z.string().uuid(),
  payeeName: z.string(), // shown on the sheet
  payeeAccountHash: z.string(), // sha256 of normalized account details, base64url
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  rail: z.enum(["CARD_ISSUING", "BANK_TRANSFER", "HANDOFF", "PAY_IN_PLACE"]),
  purpose: z.string().max(140),
  homeAmountMinor: z.number().int(), // display only, also signed
  homeCurrency: z.string().length(3),
  mandateId: z.string().uuid().nullable(),
  nonce: z.string(), // 16 random bytes, base64url
  expiresAt: z.string().datetime(), // now + 10 min (Clock)
  // (added 2026-10-11, B2) Funding route (spec §12) chosen at proposal time for BANK_TRANSFER and signed with
  // the order: the wallet balance debited, at most `fundingAmountMinor` of it (conversion + markup + fees),
  // via the route `fundingRouteId` (fixtures/rails.json) at `fundingMarkupBps`. Payments refuses a bank
  // quote whose source amount exceeds the signed maximum. All four are present together or absent.
  fundingCurrency: z.string().length(3).optional(),
  fundingAmountMinor: z.number().int().positive().optional(),
  fundingRouteId: z.string().min(1).max(64).optional(),
  fundingMarkupBps: z.number().int().nonnegative().optional(),
  // (added 2026-10-12, X1) The bill this order pays: the obligation and its period (due date, ISO 8601), both or
  // neither. Signed with the order, so a mandate (T1) payment is bound to the obligation the user's mandate
  // covers; payments re-checks the obligation independently (payee, category, amount ≤ bill, period unsettled).
  obligationId: z.string().uuid().optional(),
  obligationPeriod: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // (added 2026-10-14, Business M0) What is being bought, signed with the order (both optional, so orders without
  // them keep their JCS bytes and hash):
  // - itemsHash: base64url(sha256(JCS(items))) of a merchant order's line items (shop delivery / till bill), so the
  //   shop order fulfilled after payment is the one the user signed;
  // - purchaseOrderId: the passkey-signed supplier purchase order this payment settles; payments re-verifies the
  //   PO signature, payee = PO supplier and amount ≤ PO total.
  itemsHash: z.string().min(1).max(64).optional(),
  purchaseOrderId: z.string().uuid().optional(),
  // (added 2026-10-16, linked accounts) The linked card or bank this order is paid from. Payments pulls the signed
  // fundingAmountMinor (in fundingCurrency, the source's currency) from it into the wallet, then pays out. Only with
  // the funding binding; optional, so orders without it keep their JCS bytes and hash.
  fundingSourceId: z.string().uuid().optional(),
});
export type CanonicalOrder = z.infer<typeof CanonicalOrder>;

/**
 * orderHash = base64url(sha256(utf8(JCS(order)))). Also the WebAuthn challenge for T2.
 * The order is parsed first: unknown keys are stripped and an invalid order throws, so only a
 * schema-valid canonical order can ever be hashed (and therefore signed).
 */
export function orderHash(order: CanonicalOrder): string {
  const parsed = CanonicalOrder.parse(order);
  orderFunding(parsed); // all-or-none funding fields: a partial binding is never hashed (or signed)
  orderObligation(parsed); // all-or-none obligation link (X1)
  if (parsed.fundingSourceId !== undefined && parsed.fundingCurrency === undefined) {
    throw new RangeError("canonical order: fundingSourceId needs the funding binding");
  }
  return jcsHash(parsed);
}

/**
 * (added 2026-10-12, Track Y6, p1 B9) Allowance for exchange-rate moves between signing and the bank's conversion,
 * included in a converting order's signed maximum (fundingAmountMinor). Must equal rules/funding.ts FX_TOLERANCE_BPS
 * (a test pins it). The bank debits its actual quote; above the signed maximum nothing is sent.
 */
export const FUNDING_FX_TOLERANCE_BPS = 100;

/** Plain-language explanation of the signed maximum ("at most …") for a converting order. */
export function fundingMarginNoteEn(maxFormatted: string, fundingCurrency: string): string {
  return (
    `At most ${maxFormatted} from your ${fundingCurrency} balance: the converted amount and the route's fees, plus up to ` +
    `${FUNDING_FX_TOLERANCE_BPS / 100}% for exchange-rate moves before the bank converts. You are debited the bank's actual ` +
    "quote; if it would be higher than this maximum, nothing is sent."
  );
}

export type OrderFunding = { currency: string; maxAmountMinor: number; routeId: string; markupBps: number };

/** The signed funding binding of an order, or null for orders without one. Throws on a partial binding. */
export function orderFunding(order: CanonicalOrder): OrderFunding | null {
  const f = [order.fundingCurrency, order.fundingAmountMinor, order.fundingRouteId, order.fundingMarkupBps];
  const present = f.filter((x) => x !== undefined).length;
  if (present === 0) return null;
  if (present !== f.length) throw new RangeError("canonical order: funding fields must be all present or all absent");
  return { currency: order.fundingCurrency!, maxAmountMinor: order.fundingAmountMinor!, routeId: order.fundingRouteId!, markupBps: order.fundingMarkupBps! };
}

export type OrderObligation = { obligationId: string; period: string };

/** (added 2026-10-12, X1) The signed obligation link of an order, or null. Throws on a partial link. */
export function orderObligation(order: CanonicalOrder): OrderObligation | null {
  const present = [order.obligationId, order.obligationPeriod].filter((x) => x !== undefined).length;
  if (present === 0) return null;
  if (present !== 2) throw new RangeError("canonical order: obligationId and obligationPeriod must be both present or both absent");
  return { obligationId: order.obligationId!, period: order.obligationPeriod! };
}
