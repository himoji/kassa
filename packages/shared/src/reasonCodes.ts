import { z } from "zod";

/**
 * Every machine reason code the rules, payments, reader and rails modules can emit.
 * The app maps each code to a translated, plain-language label (i18n key per code);
 * the server never sends user-facing prose for these.
 */
export const ReasonCode = z.enum([
  // Rules: hard refusals (spec §10 evaluation order)
  "REFUSE_FROZEN",
  "REFUSE_UNVERIFIED_PAYEE",
  "REFUSE_SOURCE_MISMATCH",
  "REFUSE_SANCTIONS",
  "REFUSE_CAP",
  // Rules: handoff
  "HANDOFF_REGION",
  "HANDOFF_MODE",
  // Rules: why AUTO / ASK
  "MANDATE_MATCH",
  "MANDATE_OUT_OF_SCOPE",
  "SMALL_AUTO",
  "RISK_HIGH",
  "AGENT_REQUESTED_CONFIRM",
  "PRESET_ASK_ME",
  "CAP_WITHIN_2X_ASK",
  "PAYEE_COOLING",
  "TRIGGER_ORIGIN",
  // (added by Track A) step 9: AUTO needs SMART + verified payee + capped wallet + signed base rules
  "AUTO_NOT_ELIGIBLE",
  // (added by Track A) step 9: amount above the small auto limit
  "ABOVE_SMALL_AUTO_LIMIT",
  // Reader (I10)
  "READER_SOURCE_MISMATCH",
  "READER_FIELD_UNVERIFIED",
  // Approval / WebAuthn (rules verification, I3)
  "APPROVAL_EXPIRED",
  "ORDER_EXPIRED",
  "BAD_SIGNATURE",
  "ORDER_HASH_MISMATCH",
  "ASSERTION_INVALID",
  "USER_NOT_VERIFIED",
  "COUNTER_REGRESSION",
  // Payments independent verification (I2, I4, I5, I9)
  "NO_APPROVAL",
  "NONCE_USED",
  "MANDATE_INACTIVE",
  "PAYMENTS_DAILY_CAP",
  // Rails
  "QR_PAYEE_MISMATCH",
  "CARD_ALREADY_USED",
  "CARD_EXPIRED",
  "MERCHANT_MISMATCH",
  "AMOUNT_OVER_LIMIT",
  "CURRENCY_MISMATCH",
  // (added by Track A) the rail (mock bank / Stripe / mock world) failed or was unreachable
  "RAIL_ERROR",
  // Rule changes (I8) and webhooks (I13)
  "LOOSEN_PENDING",
  "PASSKEY_REQUIRED",
  "WEBHOOK_SIGNATURE_INVALID",
  "WEBHOOK_REPLAY_WINDOW",
  // User actions
  "USER_REJECTED",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** Codes that are hard refusals on their own: no ASK can override them. */
export const HARD_REFUSE_CODES = [
  "REFUSE_FROZEN",
  "REFUSE_UNVERIFIED_PAYEE",
  "REFUSE_SOURCE_MISMATCH",
  "REFUSE_SANCTIONS",
  "REFUSE_CAP",
] as const satisfies readonly ReasonCode[];
