import { z } from "zod";

/**
 * Money is integer minor units plus an ISO 4217 code everywhere (spec §0). These helpers are the
 * only place minor <-> major conversion happens; they work on decimal strings, never float maths.
 */

/** ISO 4217 minor-unit exponents for the currencies Kassa handles. HUF is 2 in ISO 4217. */
export const CURRENCY_EXPONENTS = {
  KZT: 2,
  HUF: 2,
  EUR: 2,
  USD: 2,
  CNY: 2,
} as const;

export const SupportedCurrency = z.enum(["KZT", "HUF", "EUR", "USD", "CNY"]);
export type SupportedCurrency = z.infer<typeof SupportedCurrency>;

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code);
}

/** Minor-unit exponent; throws for currencies Kassa does not know. */
export function currencyExponent(currency: string): number {
  if (!isSupportedCurrency(currency)) throw new RangeError(`Unsupported currency: ${currency}`);
  return CURRENCY_EXPONENTS[currency];
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
