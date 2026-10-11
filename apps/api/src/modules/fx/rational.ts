import { currencyExponent } from "@kassa/shared";

/*
 * Exact rational arithmetic for FX (spec §0: never floats for money). Rates are carried as decimal
 * strings at the edges and as BigInt fractions inside. Rounding to minor units is a single HALF_UP step
 * (ties away from zero), matching @kassa/shared `fxMath.convertMinor` so every module derives the same
 * home amounts.
 */

export interface Rational {
  num: bigint;
  den: bigint; // always > 0
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function rat(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n) throw new RangeError("rational: zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

/** Parse a plain decimal string ("502.98", "13.64") exactly. Also accepts integers. */
export function parseDecimal(s: string): Rational {
  const m = DECIMAL.exec(s.trim());
  if (!m) throw new RangeError(`not a plain decimal: ${s}`);
  const [, sign, whole = "0", frac = ""] = m;
  const n = BigInt(whole + frac) * (sign ? -1n : 1n);
  return rat(n, 10n ** BigInt(frac.length));
}

export const mul = (a: Rational, b: Rational): Rational => rat(a.num * b.num, a.den * b.den);
export const div = (a: Rational, b: Rational): Rational => {
  if (b.num === 0n) throw new RangeError("rational: division by zero");
  return rat(a.num * b.den, a.den * b.num);
};
export const add = (a: Rational, b: Rational): Rational => rat(a.num * b.den + b.num * a.den, a.den * b.den);
export const sub = (a: Rational, b: Rational): Rational => rat(a.num * b.den - b.num * a.den, a.den * b.den);
export const cmp = (a: Rational, b: Rational): number => {
  const d = a.num * b.den - b.num * a.den;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
export const fromInt = (n: number): Rational => {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${n}`);
  return rat(BigInt(n));
};

/** Round to an integer, ties away from zero (HALF_UP on the magnitude). */
export function roundHalfUp(r: Rational): bigint {
  const { num, den } = r;
  const neg = num < 0n;
  const a = neg ? -num : num;
  let q = a / den;
  if ((a % den) * 2n >= den) q += 1n;
  return neg ? -q : q;
}

export function toSafeNumber(b: bigint): number {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new RangeError(`out of safe integer range: ${b}`);
  return n;
}

/** Decimal string with up to `places` fraction digits (half-up), trailing zeros trimmed. Display / storage only. */
export function toDecimalString(r: Rational, places = 10): string {
  const scaled = roundHalfUp(mul(r, rat(10n ** BigInt(places))));
  const neg = scaled < 0n;
  const digits = (neg ? -scaled : scaled).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, -places);
  const frac = digits.slice(-places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Convert minor units of `from` to minor units of `to` at `rate` (major `to` per 1 major `from`).
 * Accounts for differing ISO 4217 exponents.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rate: Rational): number {
  const scale = rat(10n ** BigInt(currencyExponent(to)), 10n ** BigInt(currencyExponent(from)));
  return toSafeNumber(roundHalfUp(mul(mul(fromInt(amountMinor), rate), scale)));
}

/** amountMinor × bps / 10000, half-up. */
export function applyBps(amountMinor: number, bps: number): number {
  return toSafeNumber(roundHalfUp(mul(fromInt(amountMinor), rat(BigInt(bps), 10000n))));
}
