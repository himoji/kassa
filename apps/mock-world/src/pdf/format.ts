import { formatIbanPrint, fromMinor, normalizeIban } from "@kassa/shared";

import type { AmountStyle, DateStyle, IbanStyle } from "../../../../fixtures/invoices/source.ts";

/*
 * Printed formats for generated documents. Only plain ASCII spaces are used as group separators
 * (the PDFs use the standard 14 fonts with WinAnsi encoding, which has no narrow no-break space).
 */

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$" };

function group(whole: string, sep: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export function formatAmount(amountMinor: number, currency: string, style: AmountStyle): string {
  const [whole = "0", frac = ""] = fromMinor(amountMinor, currency).split(".");
  const sym = SYMBOL[currency];
  switch (style) {
    case "en-code":
      return `${currency} ${group(whole, ",")}.${frac}`;
    case "en-symbol":
      return sym ? `${sym}${group(whole, ",")}.${frac}` : `${currency} ${group(whole, ",")}.${frac}`;
    case "de-code":
      return `${group(whole, ".")},${frac} ${currency}`;
    case "de-symbol":
      return `${group(whole, ".")},${frac} ${sym ?? currency}`;
    case "at-symbol":
      return `${sym ?? currency} ${group(whole, ".")},${frac}`;
    case "hu-ft":
      if (currency !== "HUF") return `${group(whole, " ")},${frac} ${currency}`;
      return `${group(whole, " ")}${/^0+$/.test(frac) ? "" : `,${frac}`} Ft`;
    case "hu-code":
    case "kz-code":
      return `${group(whole, " ")},${frac} ${currency}`;
    case "fr-symbol":
      return `${group(whole, " ")},${frac} ${sym ?? currency}`;
  }
}

const MONTHS: Record<"en" | "de" | "hu" | "fr", string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  hu: ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
};

/** `iso` is an ISO 8601 calendar date `YYYY-MM-DD`. */
export function formatDate(iso: string, style: DateStyle): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`formatDate: not YYYY-MM-DD: ${iso}`);
  const [, y, mm, dd] = m as unknown as [string, string, string, string];
  const mi = Number(mm) - 1;
  const d = Number(dd);
  switch (style) {
    case "iso":
      return iso;
    case "long-en":
      return `${d} ${MONTHS.en[mi]} ${y}`;
    case "us-long":
      return `${MONTHS.en[mi]} ${d}, ${y}`;
    case "dmy-dot":
      return `${dd}.${mm}.${y}`;
    case "dmy-slash":
      return `${dd}/${mm}/${y}`;
    case "hu":
      return `${y}.${mm}.${dd}.`;
    case "hu-long":
      return `${y}. ${MONTHS.hu[mi]} ${d}.`;
    case "de-long":
      return `${d}. ${MONTHS.de[mi]} ${y}`;
    case "fr-long":
      return `${d === 1 ? "1er" : d} ${MONTHS.fr[mi]} ${y}`;
  }
}

export function formatIban(iban: string, style: IbanStyle): string {
  return style === "paper" ? formatIbanPrint(iban) : normalizeIban(iban);
}
