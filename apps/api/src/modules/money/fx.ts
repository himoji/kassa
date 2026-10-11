/*
 * Home-currency conversion bridge. Uses Track B's fx module (`fx/index.ts` → toHome) when present;
 * otherwise (or when it fails, e.g. offline) a labelled static fallback table of example mid rates.
 * Integer maths only: rates are decimal strings scaled to 10^8 and applied with BigInt, rounding half
 * away from zero to the target currency's minor unit (ISO 4217 exponents from @kassa/shared).
 */
import { currencyExponent, isSupportedCurrency } from "@kassa/shared";

import { isoDate } from "../clock/index.ts";

export type HomeAmount = { amountMinor: number; rate: string; rateDate: string; source: "fx" | "fallback" };

/** Example mid rates, KZT per 1 unit (labelled "example values" wherever shown). */
const FALLBACK_KZT_PER_UNIT: Record<string, string> = {
  KZT: "1",
  EUR: "560.00",
  USD: "480.00",
  HUF: "1.44",
  CNY: "67.00",
};

const SCALE = 100_000_000n;

function parseRate(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(rate.trim());
  if (!m) throw new RangeError(`bad rate ${rate}`);
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? "").padEnd(8, "0"));
}

function formatRate(scaled: bigint): string {
  const whole = scaled / SCALE;
  const frac = (scaled % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Exact decimal rate as a fraction (quoted fx rates carry up to 10 decimals; fallback rates 8). */
function rateFraction(rate: string): [bigint, bigint] {
  const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(rate.trim());
  if (!m) throw new RangeError(`bad rate ${rate}`);
  const frac = m[2] ?? "";
  return [BigInt(m[1]! + frac), 10n ** BigInt(frac.length)];
}

/** "nearest" rounds half away from zero (default); "down" truncates toward zero (caps are non-negative). */
export type Rounding = "nearest" | "down";

/** amountMinor (from) × rate (to per from) → to minor units, half away from zero unless rounding is "down". */
export function convertMinor(amountMinor: number, from: string, to: string, rate: string, rounding: Rounding = "nearest"): number {
  const expFrom = currencyExponent(from);
  const expTo = currencyExponent(to);
  const [rn, rd] = rateFraction(rate);
  const num = BigInt(amountMinor) * rn * 10n ** BigInt(expTo);
  const den = rd * 10n ** BigInt(expFrom);
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const q = rounding === "down" ? abs / den : (abs * 2n + den) / (2n * den);
  const v = Number(neg ? -q : q);
  if (!Number.isSafeInteger(v)) throw new RangeError("converted amount exceeds safe integer range");
  return v;
}

export function fallbackRate(from: string, to: string): string {
  const a = FALLBACK_KZT_PER_UNIT[from];
  const b = FALLBACK_KZT_PER_UNIT[to];
  if (!a || !b) throw new RangeError(`no fallback rate ${from}->${to}`);
  // (KZT per from) / (KZT per to), 8 dp.
  return formatRate((parseRate(a) * SCALE) / parseRate(b));
}

type FxModule = {
  toHome?: (
    amountMinor: number,
    currency: string,
    homeCurrency: string,
    date: Date | string,
  ) => Promise<{ amountMinor: number; rate: string; rateDate: string }>;
};

let fxModule: FxModule | null | undefined;
let disableFxModule = false;

async function loadFx(): Promise<FxModule | null> {
  if (disableFxModule) return null;
  if (fxModule !== undefined) return fxModule;
  try {
    const path = new URL("../fx/index.ts", import.meta.url).href;
    fxModule = (await import(/* @vite-ignore */ path)) as FxModule;
  } catch {
    fxModule = null;
  }
  return fxModule;
}

/** Tests: force the static fallback so results are deterministic and offline. */
export function useFallbackFxForTests(on: boolean): void {
  disableFxModule = on;
}

export async function toHome(
  amountMinor: number,
  currency: string,
  homeCurrency: string,
  date: Date,
  rounding: Rounding = "nearest",
): Promise<HomeAmount> {
  if (currency === homeCurrency) return { amountMinor, rate: "1", rateDate: isoDate(date), source: "fx" };
  const fx = await loadFx();
  if (fx?.toHome) {
    try {
      const r = await fx.toHome(amountMinor, currency, homeCurrency, date);
      // Rounding down is recomputed from the quoted rate (the fx module itself rounds to nearest).
      if (rounding === "down") {
        return { amountMinor: convertMinor(amountMinor, currency, homeCurrency, r.rate, "down"), rate: r.rate, rateDate: r.rateDate, source: "fx" };
      }
      if (Number.isSafeInteger(r.amountMinor)) return { ...r, source: "fx" };
    } catch {
      // fall through to the labelled fallback
    }
  }
  if (!isSupportedCurrency(currency) || !isSupportedCurrency(homeCurrency)) {
    throw new RangeError(`unsupported currency pair ${currency}/${homeCurrency}`);
  }
  const rate = fallbackRate(currency, homeCurrency);
  return { amountMinor: convertMinor(amountMinor, currency, homeCurrency, rate, rounding), rate, rateDate: isoDate(date), source: "fallback" };
}
