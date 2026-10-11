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
  return jcsHash(parsed);
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
