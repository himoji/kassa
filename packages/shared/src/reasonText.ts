import type { ReasonCode } from "./reasonCodes.ts";

/*
 * (added 2026-10-12, Track Y6) Plain-language English text for reason codes, for server-rendered text the user reads
 * (notifications, proposal summaries, sim output). Same wording as the app's locale
 * (apps/mobile/src/locales/en/reasonCodes.json "text"); the app translates codes itself.
 * Partial on purpose: a code added later without text falls back to a readable form of the code.
 */
export const REASON_TEXT_EN: Partial<Record<ReasonCode, string>> = {
  REFUSE_FROZEN: "Payments are frozen, so this one was refused. Unfreezing needs your passkey and takes 24 hours.",
  REFUSE_UNVERIFIED_PAYEE: "The recipient has not been verified, so Kassa cannot pay it. Verify the recipient first.",
  REFUSE_SOURCE_MISMATCH: "The details came from a source that does not match the payment, so it was refused. Check the request with the recipient.",
  REFUSE_SANCTIONS: "This payment was blocked by a sanctions check. It cannot be paid through Kassa.",
  REFUSE_CAP: "This payment is above one of your limits, so it was refused. Lower the amount or raise the limit with your passkey.",
  INSUFFICIENT_FUNDS: "None of your balances can cover this payment and its fees in time, so nothing was sent. Add money or convert first, then try again.",
  BALANCES_UNAVAILABLE: "Kassa could not read your wallet balances just now, so it cannot check which balance pays this. Nothing was sent; try again in a moment.",
  DUPLICATE_OBLIGATION_PAYMENT: "This bill for this period is already paid or waiting for your approval, so a second payment was refused.",
  KYC_REQUIRED: "This amount needs a verified identity first, so it was refused. Complete the identity check in Settings, then try again.",
  HANDOFF_REGION: "Because of your region, Kassa cannot send this payment. Pay it yourself using the handoff screen.",
  HANDOFF_MODE: "Your money mode is set to handoff, so you need to pay this one yourself from the handoff screen.",
  MANDATE_MATCH: "This bill matches a mandate you signed, so it can be paid automatically within its limits.",
  MANDATE_OUT_OF_SCOPE: "This payment is outside the limits of your mandate, so it needs your passkey.",
  MANDATE_SCOPE_MISMATCH: "This recipient is in one of your autopay mandates, but this payment is not the bill you signed the mandate for (or it is a different amount), so it needs your passkey.",
  MANDATE_NOT_DUE_YET: "Your mandate pays this bill on its own only when it is due within 3 days. It is not due yet, so paying it now needs your passkey.",
  CONVERT_OWN_BALANCES: "This exchanges money between your own balances. Kassa always asks for your passkey before converting.",
  SMALL_AUTO: "This is under your auto-pay limit to a verified recipient, so Kassa can pay it without asking.",
  SMALL_AUTO_BUDGET_EXHAUSTED: "Kassa already paid the most small amounts it may pay on its own today, so this one needs your passkey.",
  FIRST_PAYMENT_TO_PAYEE: "This is your first payment to this recipient, so it needs your passkey. Later small payments to them can go automatically.",
  RISK_HIGH: "The rules see something unusual about this payment, so they ask you to approve it.",
  AGENT_REQUESTED_CONFIRM: "Kassa asked for your approval before it goes ahead, so nothing is paid until you sign it.",
  PRESET_ASK_ME: "You chose Ask me, so every payment needs your passkey.",
  CAP_WITHIN_2X_ASK: "This payment is close to your limit, so the rules ask you to confirm it.",
  PAYEE_COOLING: "This recipient is new or changed, so it cools down for 24 hours before it can be paid.",
  PAYEE_ACCOUNT_MISSING: "Kassa does not have this recipient's account details yet, so it cannot pay them. Add the recipient's details first.",
  TRIGGER_ORIGIN: "This payment came from a message or notification, so it needs your approval before it goes ahead.",
  TRIGGER_NEEDS_MANDATE: "This was started automatically (not by you), so it only pays on its own inside a mandate you signed.",
  AUTO_NOT_ELIGIBLE: "Auto-pay needs Smart mode, a verified recipient, a capped wallet and signed base rules, and one of these is missing.",
  ABOVE_SMALL_AUTO_LIMIT: "The amount is above your auto-pay limit, so it needs your passkey.",
  READER_SOURCE_MISMATCH: "The document does not come from the sender it names, so Kassa will not use its details.",
  READER_FIELD_UNVERIFIED: "One of the details in this document could not be verified, so please check it before you pay.",
  APPROVAL_EXPIRED: "Your approval ran out before it was used, so nothing was paid. Review the order and approve it again.",
  ORDER_EXPIRED: "This order is no longer valid, so nothing was paid. Ask Kassa for a new one.",
  BAD_SIGNATURE: "The passkey signature could not be verified, so nothing was paid. Try approving again.",
  ORDER_HASH_MISMATCH: "The order is not the same as the one you signed, so nothing was paid. Review it again.",
  ASSERTION_INVALID: "Your passkey response was not accepted, so nothing was paid. Try again.",
  USER_NOT_VERIFIED: "Your passkey was not verified for this action, so nothing was paid.",
  COUNTER_REGRESSION: "This passkey response is older than the last one, so it was refused for safety. Try again.",
  NO_APPROVAL: "Kassa did not find your approval for this payment, so nothing was paid.",
  NONCE_USED: "This approval was already used, so it cannot be used again. Nothing was paid twice.",
  MANDATE_INACTIVE: "The mandate for this bill is not active yet or has been revoked, so it cannot pay automatically.",
  PAYMENTS_DAILY_CAP: "You have reached your daily payment limit, so this payment waits until tomorrow or until you raise the limit.",
  QR_PAYEE_MISMATCH: "The name in the QR code does not match the verified recipient, so Kassa will not let you pay it.",
  CARD_ALREADY_USED: "This one-time card was already used, so it cannot be charged again.",
  CARD_EXPIRED: "The card for this payment has expired, so it was not charged. Ask Kassa to try again.",
  MERCHANT_MISMATCH: "The merchant does not match the payment you approved, so nothing was charged.",
  AMOUNT_OVER_LIMIT: "The amount is more than the card allows, so nothing was charged.",
  CURRENCY_MISMATCH: "The currency does not match the payment you approved, so nothing was charged.",
  RAIL_ERROR: "The payment provider failed or could not be reached, so nothing was confirmed. Try again later.",
  FUNDING_SOURCE_UNAVAILABLE: "The card or bank account you chose to pay from is no longer linked, so nothing was sent.",
  FUNDING_PULL_DECLINED: "Your linked card or bank declined the payment, so nothing was sent. Try another account or your Kassa wallet.",
  FUNDING_ABOVE_SIGNED_MAX: "The bank asked for more than the maximum you signed, so nothing was sent. Review the new amount and sign again.",
  INVOICE_ABOVE_PO: "The supplier's invoice is for more than the purchase order you signed, so it was refused. Ask the supplier for a corrected invoice.",
  INVOICE_ACCOUNT_MISMATCH: "The invoice asks you to pay an account that is not the supplier's verified account, so it was refused. Check with the supplier by phone before paying anything.",
  PO_NOT_DELIVERED: "This purchase order has not been delivered yet, so its invoice cannot be paid.",
  PO_ABOVE_FORECAST: "This purchase order is much larger than your stock forecast suggests, so it needs your passkey.",
  LOOSEN_PENDING: "A change that loosens a rule is still waiting for its 24-hour delay to end.",
  PASSKEY_REQUIRED: "This change needs your passkey before it can be made.",
  WEBHOOK_SIGNATURE_INVALID: "A payment update failed its signature check, so Kassa ignored it.",
  WEBHOOK_REPLAY_WINDOW: "A payment update arrived too late to trust, so Kassa ignored it.",
  WEBHOOK_REPLAYED: "A payment update was sent a second time, so Kassa ignored the copy.",
  USER_REJECTED: "You rejected this order, so nothing was sent.",
  AI_CONSENT_REQUIRED: "Kassa's assistant is an AI. Agree to AI processing in Settings > Privacy before chatting with it.",
  PIPL_CONSENT_REQUIRED: "You are in region CN and Kassa's AI runs outside mainland China. Under China's PIPL this needs your separate consent: give it in Settings > Privacy > Cross-border AI processing before using the assistant.",
  PROCESSING_RESTRICTED: "You restricted processing of your data, so Kassa keeps it but does not use it. Lift the restriction by unfreezing with your passkey.",
  ACCOUNT_ERASED: "This account was erased at your request. Its personal data can no longer be read.",
  UNFREEZE_PENDING: "Unfreezing is a loosening, so it takes effect 24 hours after you confirmed it with your passkey.",
  RATE_LIMITED: "Too many requests in a short time. Wait a minute and try again.",
};

/** One code in plain language (unknown codes: a readable form, "Some new code." from SOME_NEW_CODE). */
export function reasonTextEn(code: ReasonCode | string): string {
  const t = REASON_TEXT_EN[code as ReasonCode];
  if (t) return t;
  const words = code.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1) + ".";
}

/** "Reasons: <text> (CODE); <text> (CODE)." — plain language next to each code, for summaries and notifications. */
export function reasonsSentenceEn(codes: readonly (ReasonCode | string)[]): string {
  if (codes.length === 0) return "Reasons: none.";
  return `Reasons: ${codes.map((c) => `${reasonTextEn(c).replace(/\.$/, "")} (${c})`).join("; ")}.`;
}
