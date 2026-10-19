import type { Decision, ProposalStatus } from "./enums.ts";
import { fromMinor } from "./money.ts";
import { orderConversion, orderFunding, type CanonicalOrder } from "./order.ts";

/*
 * (added 2026-10-18) One English sentence built only from a canonical order: what it pays (or converts), to whom,
 * from which balance, at most how much, by which route. The proposal card carries it (and channels without cards get
 * it under the reply), so the funding source the user reads is the order's, never the model's paraphrase.
 *
 * (2026-10-19) Worded by where the order stands (`OrderLineStance`), not always "Signed order": a judge read
 * "Signed order: EUR 2,400.00 …" on an order still waiting for the passkey. ASK waiting → "Order to sign", signed →
 * "Signed order", AUTO executed → "Paid under your mandate" / "Paid under your small-payment limit", anything else
 * (rejected, expired, failed) → "Order". A refused order has no line. The app builds the same sentence in the user's
 * language from the card's structured fields (`orderFacts`); this English one is the fallback and the text channel's.
 */

/** "EUR 2,400.00", "HUF 35,327.45", "KZT 990.00": ISO code and grouped major units (the format the planner quotes). */
export function isoMoney(amountMinor: number, currency: string): string {
  const major = fromMinor(amountMinor, currency);
  const negative = major.startsWith("-");
  const [whole = "0", frac] = (negative ? major.slice(1) : major).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

export const ORDER_LINE_STANCES = ["TO_SIGN", "SIGNED", "PAID_MANDATE", "PAID_SMALL_AUTO", "ORDER"] as const;
export type OrderLineStance = (typeof ORDER_LINE_STANCES)[number];

const STANCE_EN: Record<OrderLineStance, string> = {
  TO_SIGN: "Order to sign",
  SIGNED: "Signed order",
  PAID_MANDATE: "Paid under your mandate",
  PAID_SMALL_AUTO: "Paid under your small-payment limit",
  ORDER: "Order",
};

/** How an order's line is introduced, from its decision and status; null for a refused order (no line). */
export function orderLineStance(decision: Decision, status: ProposalStatus, order: Pick<CanonicalOrder, "mandateId"> | null): OrderLineStance | null {
  if (decision === "REFUSE" || status === "REFUSED") return null;
  if (decision === "AUTO") return status === "EXECUTED" ? (order?.mandateId ? "PAID_MANDATE" : "PAID_SMALL_AUTO") : "ORDER";
  if (status === "PENDING_APPROVAL") return "TO_SIGN";
  if (status === "APPROVED" || status === "EXECUTED" || status === "HANDOFF") return "SIGNED";
  return "ORDER";
}

const RAIL_WORDS: Record<CanonicalOrder["rail"], string> = {
  BANK_TRANSFER: "by bank transfer",
  CARD_ISSUING: "with a one-time card",
  PAY_IN_PLACE: "paid in place",
  HANDOFF: "paid by you in your own wallet (handoff)",
  CONVERT: "as a conversion",
};

/** The order itself, without its introduction ("EUR 2,400.00 to …, funded from …"). Never throws. */
export function orderBodyEn(order: CanonicalOrder): string {
  try {
    const conversion = orderConversion(order);
    if (conversion) {
      return (
        `convert from your ${conversion.fromCurrency} balance into ${isoMoney(conversion.amountMinor, conversion.toCurrency)} ` +
        `in your ${conversion.toCurrency} balance, debiting at most ${isoMoney(conversion.maxDebitMinor, conversion.fromCurrency)} incl. fees ` +
        `(route ${conversion.routeId}).`
      );
    }
    const pay = `${isoMoney(order.amountMinor, order.currency)} to ${order.payeeName}`;
    const funding = orderFunding(order);
    if (!funding) return `${pay}, ${RAIL_WORDS[order.rail]}.`;
    const from = order.fundingSourceId ? `your linked ${funding.currency} account` : `your ${funding.currency} balance`;
    return `${pay}, funded from ${from}: at most ${isoMoney(funding.maxAmountMinor, funding.currency)} incl. fees (route ${funding.routeId}).`;
  } catch {
    return `${order.amountMinor} ${order.currency} (minor units) to ${order.payeeName}.`;
  }
}

/** The order in one sentence (see the header), introduced by its stance (default: an order still to sign). */
export function orderLineEn(order: CanonicalOrder, stance: OrderLineStance = "TO_SIGN"): string {
  return `${STANCE_EN[stance]}: ${orderBodyEn(order)}`;
}
