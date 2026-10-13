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

/**
 * The demo's own currencies: the simulated wallet and bank rails hold balances in these, and the offline example
 * rate table covers them. Any other known currency works for records, bills, budgets and cards.
 */
export const SupportedCurrency = z.enum(["KZT", "HUF", "EUR", "USD", "CNY"]);
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
