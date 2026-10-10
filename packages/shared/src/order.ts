import { z } from "zod";

import { jcsHash } from "./jcs.ts";

// Spec §7, verbatim. Changing a field here changes every orderHash: bump `v`.
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
});
export type CanonicalOrder = z.infer<typeof CanonicalOrder>;

/**
 * orderHash = base64url(sha256(utf8(JCS(order)))). Also the WebAuthn challenge for T2.
 * The order is parsed first: unknown keys are stripped and an invalid order throws, so only a
 * schema-valid canonical order can ever be hashed (and therefore signed).
 */
export function orderHash(order: CanonicalOrder): string {
  return jcsHash(CanonicalOrder.parse(order));
}
