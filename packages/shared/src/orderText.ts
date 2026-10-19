import { fromMinor } from "./money.ts";
import { orderConversion, orderFunding, type CanonicalOrder } from "./order.ts";

/*
 * (added 2026-10-18) One English sentence built only from a signed canonical order: what it pays (or converts), to
 * whom, from which balance, at most how much, by which route. The chat shows it under the assistant's reply and the
 * proposal card carries it, so the funding source the user reads is the signed one, never the model's paraphrase.
 */

/** "EUR 2,400.00", "HUF 35,327.45", "KZT 990.00": ISO code and grouped major units (the format the planner quotes). */
export function isoMoney(amountMinor: number, currency: string): string {
  const major = fromMinor(amountMinor, currency);
  const negative = major.startsWith("-");
  const [whole = "0", frac] = (negative ? major.slice(1) : major).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

const RAIL_WORDS: Record<CanonicalOrder["rail"], string> = {
  BANK_TRANSFER: "by bank transfer",
  CARD_ISSUING: "with a one-time card",
  PAY_IN_PLACE: "paid in place",
  HANDOFF: "paid by you in your own wallet (handoff)",
  CONVERT: "as a conversion",
};

/** The signed order in one sentence (see the header). Never throws: an order it cannot format gets a plain fallback. */
export function orderLineEn(order: CanonicalOrder): string {
  try {
    const conversion = orderConversion(order);
    if (conversion) {
      return (
        `Signed order: convert from your ${conversion.fromCurrency} balance into ${isoMoney(conversion.amountMinor, conversion.toCurrency)} ` +
        `in your ${conversion.toCurrency} balance, debiting at most ${isoMoney(conversion.maxDebitMinor, conversion.fromCurrency)} incl. fees ` +
        `(route ${conversion.routeId}).`
      );
    }
    const pay = `Signed order: ${isoMoney(order.amountMinor, order.currency)} to ${order.payeeName}`;
    const funding = orderFunding(order);
    if (!funding) return `${pay}, ${RAIL_WORDS[order.rail]}.`;
    const from = order.fundingSourceId ? `your linked ${funding.currency} account` : `your ${funding.currency} balance`;
    return `${pay}, funded from ${from}: at most ${isoMoney(funding.maxAmountMinor, funding.currency)} incl. fees (route ${funding.routeId}).`;
  } catch {
    return `Signed order: ${order.amountMinor} ${order.currency} (minor units) to ${order.payeeName}.`;
  }
}
