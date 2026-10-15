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
  // (added 2026-10-11, B2) no funding currency × rail covers the order incl. fees by its due date (spec §12)
  "INSUFFICIENT_FUNDS",
  // (added 2026-10-11, B4) the obligation period already has a pending or paid proposal
  "DUPLICATE_OBLIGATION_PAYMENT",
  // Rules: handoff
  "HANDOFF_REGION",
  "HANDOFF_MODE",
  // Rules: why AUTO / ASK
  "MANDATE_MATCH",
  "MANDATE_OUT_OF_SCOPE",
  // (added 2026-10-12, X1) the payee is in a mandate but the draft is not linked server-side to an obligation in
  // the mandate's scope (payee, category, amount ≤ the bill, period not settled) → ASK, never AUTO
  "MANDATE_SCOPE_MISMATCH",
  "SMALL_AUTO",
  // (added 2026-10-12, X3) the per-day small-auto budget (count / amount) is used up → ASK
  "SMALL_AUTO_BUDGET_EXHAUSTED",
  "RISK_HIGH",
  "AGENT_REQUESTED_CONFIRM",
  "PRESET_ASK_ME",
  "CAP_WITHIN_2X_ASK",
  "PAYEE_COOLING",
  // (added 2026-10-13) the payee has no account details yet (created from the onboarding chat): never payable
  "PAYEE_ACCOUNT_MISSING",
  "TRIGGER_ORIGIN",
  // (added 2026-10-12) a trigger/scheduler draft outside a mandate never auto-pays via the small-auto limit
  "TRIGGER_NEEDS_MANDATE",
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
  // (added 2026-10-11, B2) the bank quote's source amount exceeds the signed fundingAmountMinor: nothing sent
  "FUNDING_ABOVE_SIGNED_MAX",
  // (added 2026-10-16, linked accounts) the signed linked card or bank is gone or removed: nothing pulled or sent
  "FUNDING_SOURCE_UNAVAILABLE",
  // the linked card or bank declined the pull: nothing sent
  "FUNDING_PULL_DECLINED",
  // (added 2026-10-14, Business M0) supplier purchase orders and their invoices (three-way match, M5)
  // the invoice total is above the passkey-signed purchase order total: refused
  "INVOICE_ABOVE_PO",
  // the invoice's account is not the verified supplier payee's account (e.g. a swapped IBAN): refused
  "INVOICE_ACCOUNT_MISMATCH",
  // the purchase order has not been delivered yet, so its invoice cannot be paid
  "PO_NOT_DELIVERED",
  // the drafted purchase order is far above what the stock forecast suggests (> 2x) → ASK
  "PO_ABOVE_FORECAST",
  // Rule changes (I8) and webhooks (I13)
  "LOOSEN_PENDING",
  "PASSKEY_REQUIRED",
  "WEBHOOK_SIGNATURE_INVALID",
  "WEBHOOK_REPLAY_WINDOW",
  // (added 2026-10-11) a valid signed webhook delivered a second time inside the window (seen-signature store)
  "WEBHOOK_REPLAYED",
  // User actions
  "USER_REJECTED",
  // (added by Phase 2 security) GDPR / EU AI Act and abuse controls
  "AI_CONSENT_REQUIRED",
  // (added 2026-10-12, Track Y3) region CN: separate cross-border consent for AI processing (PIPL Art. 38–39)
  "PIPL_CONSENT_REQUIRED",
  "PROCESSING_RESTRICTED",
  "ACCOUNT_ERASED",
  "UNFREEZE_PENDING",
  "RATE_LIMITED",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** Codes that are hard refusals on their own: no ASK can override them. */
export const HARD_REFUSE_CODES = [
  "REFUSE_FROZEN",
  "REFUSE_UNVERIFIED_PAYEE",
  "REFUSE_SOURCE_MISMATCH",
  "REFUSE_SANCTIONS",
  "REFUSE_CAP",
  "INSUFFICIENT_FUNDS",
  "DUPLICATE_OBLIGATION_PAYMENT",
] as const satisfies readonly ReasonCode[];
