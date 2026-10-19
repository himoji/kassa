import currencyCodes from "currency-codes";
import { z } from "zod";

/**
 * Money is integer minor units plus an ISO 4217 code everywhere (spec §0). These helpers are the
 * only place minor <-> major conversion happens; they work on decimal strings, never float maths.
 */

/**
 * Every active ISO 4217 currency (the `currency-codes` package: the ISO maintenance agency's list), without precious
 * metals, test / special drawing codes and fund codes, which are never what a person pays or earns in.
 */
const NOT_MONEY = new Set(["XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU", "XTS", "XUA", "XXX", "BOV", "CHE", "CHW", "CLF", "COU", "MXV", "USN", "UYI", "UYW"]);

export interface CurrencyInfo {
  code: string;
  /** English ISO name ("Forint"); apps localise with Intl.DisplayNames. */
  name: string;
  /** ISO 4217 minor-unit exponent. */
  digits: number;
  countries: string[];
}

export const CURRENCIES: readonly CurrencyInfo[] = currencyCodes
  .data.filter((c) => !NOT_MONEY.has(c.code) && Number.isInteger(c.digits))
  .map((c) => ({ code: c.code, name: c.currency, digits: c.digits, countries: c.countries }))
  .sort((a, b) => a.code.localeCompare(b.code));

/** ISO 4217 minor-unit exponents of every currency Kassa knows. HUF is 2 in ISO 4217. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.digits]));

/** The demo's own currencies (Dana's money): pickers list these first. */
export const FEATURED_CURRENCIES = ["KZT", "HUF", "EUR", "USD", "CNY"] as const;

/**
 * Every currency the wallet can hold, convert and pay out in: each active ISO 4217 currency with a published mid
 * rate (ECB via Frankfurter, NBK for KZT, open.er-api.com for the rest), which is exactly the key set of the offline
 * example table fixtures/fx-rates.json (a test keeps the two equal). Currencies of comprehensively sanctioned
 * jurisdictions are left out. Any other known currency still works for records, bills, budgets and cards.
 */
export const WALLET_CURRENCIES = [
  "KZT", "HUF", "EUR", "USD", "CNY", "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM",
  "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF",
  "CHF", "CLP", "COP", "CRC", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "FJD", "FKP", "GBP",
  "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "IDR", "ILS", "INR", "IQD", "ISK", "JMD",
  "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KRW", "KWD", "KYD", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD",
  "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO",
  "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SZL", "THB", "TJS", "TMT",
  "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD",
  "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
] as const;

export const SupportedCurrency = z.enum(WALLET_CURRENCIES);
export type SupportedCurrency = z.infer<typeof SupportedCurrency>;

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SupportedCurrency.options as readonly string[]).includes(code);
}

/** Any active ISO 4217 currency (see CURRENCIES). */
export function isKnownCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code);
}

/** Minor-unit exponent; throws for currencies Kassa does not know. */
export function currencyExponent(currency: string): number {
  if (!isKnownCurrency(currency)) throw new RangeError(`Unsupported currency: ${currency}`);
  return CURRENCY_EXPONENTS[currency]!;
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Major amount -> integer minor units. Accepts a decimal string ("12.34", "-5", "1200.5") or a
 * finite number whose shortest decimal form has no more fraction digits than the currency allows.
 * Throws instead of rounding: excess precision is a bug upstream, not something to hide.
 */
export function toMinor(amount: string | number, currency: string): number {
  const exp = currencyExponent(currency);
  let text: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) throw new RangeError(`toMinor: not a finite number: ${amount}`);
    text = String(amount);
  } else {
    text = amount.trim();
  }
  const m = DECIMAL.exec(text);
  if (!m) throw new RangeError(`toMinor: not a plain decimal: ${text}`);
  const [, sign, whole = "0", frac = ""] = m;
  if (frac.length > exp) {
    throw new RangeError(`toMinor: ${text} has more than ${exp} fraction digits for ${currency}`);
  }
  const digits = (whole + frac.padEnd(exp, "0")).replace(/^0+(?=\d)/, "");
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw new RangeError(`toMinor: ${text} exceeds the safe integer range`);
  return sign && value !== 0 ? -value : value;
}

/** Integer minor units -> major amount as an exact decimal string ("1234" KZT -> "12.34"). */
export function fromMinor(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError(`fromMinor: not a safe integer: ${amountMinor}`);
  const exp = currencyExponent(currency);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exp + 1, "0");
  const whole = exp === 0 ? digits : digits.slice(0, -exp);
  const frac = exp === 0 ? "" : digits.slice(-exp);
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Localised currency display via Intl, always with the currency's ISO exponent of fraction digits.
 * Formatting only - the app does no money maths beyond this (spec §16).
 */
export function formatMoney(amountMinor: number, currency: string, locale = "en"): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(Number(fromMinor(amountMinor, currency)));
}

/** A money value as carried in DTOs. */
export const Money = z.object({
  amountMinor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof Money>;

/** A funding route row as in fixtures/rails.json. */
export interface RailsFixtureRoute {
  routeId: string;
  label: string;
  fundingCurrency: string;
  rail: string;
  provider?: string;
  cardKind?: string | null;
  feeFixedMinor: number;
  feeCurrency: string;
  markupBps: number;
  settlementDays: number;
}

/**
 * fixtures/rails.json prices the demo currencies one by one. Every other wallet currency gets the mock bank's
 * generic transfer (`<code>-mock-bank`, no fixed fee, 0.50 % over mid, next day), so a balance in any of them can
 * fund a payment or a conversion. The API's route optimizer and the mock bank both build their lists with this, so
 * a route id one of them proposes is one the other can execute. Example values, labelled as such like the fixture.
 */
export function withGenericMockBankRoutes<T extends RailsFixtureRoute>(routes: readonly T[]): Array<T | RailsFixtureRoute> {
  const covered = new Set(routes.filter((r) => r.provider === "MOCK_BANK").map((r) => r.fundingCurrency));
  const generic: RailsFixtureRoute[] = WALLET_CURRENCIES.filter((c) => !covered.has(c)).map((c) => ({
    routeId: `${c.toLowerCase()}-mock-bank`,
    label: "Mock bank transfer (Wise-like)",
    fundingCurrency: c,
    rail: "BANK_TRANSFER",
    provider: "MOCK_BANK",
    cardKind: null,
    feeFixedMinor: 0,
    feeCurrency: c,
    markupBps: 50,
    settlementDays: 1,
  }));
  return [...routes, ...generic];
}
