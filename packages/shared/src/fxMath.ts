import { currencyExponent } from "./money.ts";

/*
 * Exact currency conversion on integer minor units. Rates are decimal strings (never floats,
 * spec §0); the arithmetic is BigInt rational maths with a single rounding step at the end.
 */

export type Rounding = "HALF_UP" | "FLOOR" | "CEIL";

interface Ratio {
  num: bigint;
  den: bigint;
}

const DECIMAL_RATE = /^(\d+)(?:\.(\d+))?$/;

/** "612.40" -> 61240/100. Rejects negatives, exponents and empty strings. */
export function parseRate(rate: string): Ratio {
  const m = DECIMAL_RATE.exec(rate.trim());
  if (!m) throw new RangeError(`parseRate: not a plain positive decimal: ${rate}`);
  const frac = m[2] ?? "";
  const num = BigInt(`${m[1]}${frac}`);
  if (num === 0n) throw new RangeError("parseRate: rate must be > 0");
  return { num, den: 10n ** BigInt(frac.length) };
}

function divRound(num: bigint, den: bigint, rounding: Rounding): bigint {
  // num, den > 0 here (amounts are handled by sign separately).
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  if (rounding === "FLOOR") return q;
  if (rounding === "CEIL") return q + 1n;
  return r * 2n >= den ? q + 1n : q;
}

/**
 * Convert `amountMinor` of `from` into `to` minor units at `rate` (units of `to` per one unit of
 * `from`), optionally worsened by `markupBps`. `markupMode` says which way the markup bites:
 * `PAY_MORE` (default) multiplies by (1 + m), e.g. the source amount needed for a fixed target;
 * `RECEIVE_LESS` divides by (1 + m), e.g. the target received for a fixed source. Exponents come
 * from ISO 4217 via `currencyExponent`. Negative amounts convert symmetrically.
 */
export function convertMinor(
  amountMinor: number,
  from: string,
  to: string,
  rate: string,
  opts: { markupBps?: number; rounding?: Rounding; markupMode?: "PAY_MORE" | "RECEIVE_LESS" } = {},
): number {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("convertMinor: amount must be a safe integer");
  const markupBps = opts.markupBps ?? 0;
  if (!Number.isInteger(markupBps) || markupBps < 0) throw new RangeError("convertMinor: markupBps must be an integer >= 0");
  const r = from === to ? { num: 1n, den: 1n } : parseRate(rate);
  const expFrom = currencyExponent(from);
  const expTo = currencyExponent(to);
  const sign = amountMinor < 0 ? -1n : 1n;
  const receiveLess = opts.markupMode === "RECEIVE_LESS";
  let num = BigInt(Math.abs(amountMinor)) * r.num * (receiveLess ? 10_000n : BigInt(10_000 + markupBps));
  let den = r.den * (receiveLess ? BigInt(10_000 + markupBps) : 10_000n);
  if (expTo >= expFrom) num *= 10n ** BigInt(expTo - expFrom);
  else den *= 10n ** BigInt(expFrom - expTo);
  const out = sign * divRound(num, den, opts.rounding ?? "HALF_UP");
  const n = Number(out);
  if (!Number.isSafeInteger(n)) throw new RangeError("convertMinor: result exceeds the safe integer range");
  return n;
}

/**
 * Cross rate from a table quoted against one base (ECB style: 1 BASE = rates[X] X).
 * Returns units of `to` per one unit of `from` as a decimal string with `scale` fraction digits
 * (rounded half up).
 */
export function crossRate(rates: Readonly<Record<string, string>>, from: string, to: string, scale = 10): string {
  if (from === to) return "1";
  const rf = rates[from];
  const rt = rates[to];
  if (rf === undefined || rt === undefined) throw new RangeError(`crossRate: no rate for ${rf === undefined ? from : to}`);
  const a = parseRate(rf);
  const b = parseRate(rt);
  // (b.num / b.den) / (a.num / a.den)
  const num = b.num * a.den * 10n ** BigInt(scale);
  const den = b.den * a.num;
  const scaled = divRound(num, den, "HALF_UP").toString().padStart(scale + 1, "0");
  const whole = scaled.slice(0, scaled.length - scale);
  const frac = scaled.slice(scaled.length - scale).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
