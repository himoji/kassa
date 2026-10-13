import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isKnownCurrency } from "@kassa/shared";

import { addBusinessDays, isoDate, withinOneBusinessDay } from "./dates.ts";
import { convertMinor, div, parseDecimal, rat, toDecimalString, type Rational } from "./rational.ts";

/*
 * Daily FX rates (spec §12 "Rates").
 *  - Cross rates of the ~30 ECB currencies (EUR, USD, HUF, CNY, GBP, ...): ECB reference rates via Frankfurter. Verified 2026-10-10:
 *    `GET https://api.frankfurter.dev/v1/{YYYY-MM-DD}?base=EUR&symbols=...` returns the last published
 *    business day on or before the date (api.frankfurter.app 301-redirects there).
 *  - KZT: National Bank of Kazakhstan official rates. Verified 2026-10-10:
 *    `GET https://nationalbank.kz/rss/get_rates.cfm?fdate=DD.MM.YYYY` → XML <item><title>ISO</title>
 *    <description>KZT per quant units</description><quant>n</quant>.
 *  - Fallback (labelled `FALLBACK_ER_API` in the UI): open.er-api.com latest, which covers KZT and almost every other
 *    ISO 4217 currency (the only live source for most of them).
 *  - Last resort (labelled `STATIC_EXAMPLE`): `fixtures/fx-rates.json` (Track D's example table, EUR
 *    base) or, if absent, the built-in table below (ECB/NBK 2026-10-09). Used offline (FX_OFFLINE=1,
 *    NODE_ENV=test, CI) so the demo never blocks on the network.
 * Cached per (source, date). Rates are exact decimal strings → BigInt rationals; never floats.
 */

export type RateSource = "ECB_FRANKFURTER" | "NBK" | "FALLBACK_ER_API" | "STATIC_EXAMPLE";

export interface RateQuote {
  from: string;
  to: string;
  /** Major units of `to` per 1 major unit of `from`. */
  rate: Rational;
  /** Same rate as a decimal string (10 fraction digits max). */
  rateString: string;
  /** ISO date the rate was published for. */
  rateDate: string;
  source: RateSource;
}

/** One day's table: major units of `quote` per 1 unit of each currency, as decimal strings. */
interface DayTable {
  date: string;
  quote: string; // "EUR" for Frankfurter (EUR per unit is 1/rate), "KZT" for NBK
  /** currency -> units of `quote` per 1 unit of currency */
  perUnit: Map<string, Rational>;
  source: RateSource;
}

/** ECB (EUR base) and NBK published values for 2026-10-09, labelled example values. */
export const STATIC_EXAMPLE = {
  date: "2026-10-09",
  eurPer: { USD: "1.1206", HUF: "365.08", CNY: "7.4992" } as Record<string, string>,
  kztPer: { EUR: "502.98", USD: "447.73", HUF: "1.364", CNY: "66.78" } as Record<string, string>,
};

export interface RatesOptions {
  fetch?: typeof fetch;
  offline?: boolean;
  frankfurterBase?: string;
  nbkBase?: string;
  fallbackBase?: string;
}

export class RatesService {
  private readonly cache = new Map<string, Promise<DayTable | null>>();
  private readonly fetchFn: typeof fetch;
  private readonly offline: boolean;
  private readonly frankfurterBase: string;
  private readonly nbkBase: string;
  private readonly fallbackBase: string;

  constructor(opts: RatesOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.offline = opts.offline ?? false;
    this.frankfurterBase = opts.frankfurterBase ?? "https://api.frankfurter.dev/v1";
    this.nbkBase = opts.nbkBase ?? "https://nationalbank.kz/rss/get_rates.cfm";
    this.fallbackBase = opts.fallbackBase ?? "https://open.er-api.com/v6/latest";
  }

  /** Rate for converting `from` → `to` on `date` (purchase / due date), ±1 business day. */
  async getRate(from: string, to: string, date: string): Promise<RateQuote> {
    for (const c of [from, to]) if (!isKnownCurrency(c)) throw new RangeError(`Unsupported currency: ${c}`);
    if (from === to) return quote(from, to, rat(1n), date, "STATIC_EXAMPLE");
    const kzt = from === "KZT" || to === "KZT";
    const tables: Array<() => Promise<DayTable | null>> = this.offline
      ? []
      : kzt
        ? [() => this.dayTable("NBK", date), () => this.dayTable("FALLBACK_ER_API", date)]
        : [() => this.dayTable("ECB_FRANKFURTER", date), () => this.dayTable("FALLBACK_ER_API", date)];
    for (const load of tables) {
      const t = await load();
      if (!t) continue;
      // The live fallback only has "latest": accept it regardless of date but keep its label.
      if (t.source !== "FALLBACK_ER_API" && !withinOneBusinessDay(date, t.date)) continue;
      const r = crossRate(t, from, to);
      if (r) return quote(from, to, r, t.date, t.source);
    }
    const t = staticTable(kzt);
    const r = crossRate(t, from, to);
    if (!r) throw new RangeError(`No rate for ${from}->${to}`);
    return quote(from, to, r, t.date, "STATIC_EXAMPLE");
  }

  /** Mid-market conversion of minor units. */
  async convert(amountMinor: number, from: string, to: string, date: string) {
    const q = await this.getRate(from, to, date);
    return { amountMinor: convertMinor(amountMinor, from, to, q.rate), quote: q };
  }

  private dayTable(source: RateSource, date: string): Promise<DayTable | null> {
    const key = `${source}|${source === "FALLBACK_ER_API" ? "latest" : date}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(source, date).catch(() => null);
      this.cache.set(key, p);
      // Do not cache failures for the whole day: allow a retry on the next call.
      void p.then((t) => {
        if (!t) this.cache.delete(key);
      });
    }
    return p;
  }

  private async load(source: RateSource, date: string): Promise<DayTable | null> {
    if (source === "ECB_FRANKFURTER") {
      const res = await this.fetchFn(`${this.frankfurterBase}/${date}?base=EUR`);
      if (!res.ok) return null;
      const body = (await res.json()) as { date: string; rates: Record<string, number> };
      const perUnit = new Map<string, Rational>([["EUR", rat(1n)]]);
      // JSON numbers here are decimal literals; String() gives their shortest round-trip form.
      for (const [c, v] of Object.entries(body.rates)) perUnit.set(c, div(rat(1n), parseDecimal(String(v))));
      return { date: body.date, quote: "EUR", perUnit, source };
    }
    if (source === "NBK") {
      // NBK publishes every calendar day; try the date, then the previous business day.
      for (const d of [date, addBusinessDays(date, -1)]) {
        const [y, m, dd] = d.split("-");
        const res = await this.fetchFn(`${this.nbkBase}?fdate=${dd}.${m}.${y}`);
        if (!res.ok) continue;
        const t = parseNbkXml(await res.text(), d);
        if (t && t.perUnit.size > 1) return t;
      }
      return null;
    }
    if (source === "FALLBACK_ER_API") {
      const res = await this.fetchFn(`${this.fallbackBase}/EUR`);
      if (!res.ok) return null;
      const body = (await res.json()) as { result: string; time_last_update_unix: number; rates: Record<string, number> };
      if (body.result !== "success") return null;
      const perUnit = new Map<string, Rational>();
      for (const [c, v] of Object.entries(body.rates)) {
        if (!isKnownCurrency(c) || typeof v !== "number" || !(v > 0)) continue;
        try {
          perUnit.set(c, div(rat(1n), parseDecimal(String(v))));
        } catch {
          // a value String() writes in exponent form: skip that currency, keep the table
        }
      }
      return { date: isoDate(new Date(body.time_last_update_unix * 1000)), quote: "EUR", perUnit, source };
    }
    return null;
  }
}

/** Parse the NBK RSS XML into KZT-per-unit rates. Tolerant regex parse (fixed, simple format). */
export function parseNbkXml(xml: string, fallbackDate: string): DayTable | null {
  const perUnit = new Map<string, Rational>([["KZT", rat(1n)]]);
  const dm = /<date>(\d{2})\.(\d{2})\.(\d{4})<\/date>/.exec(xml);
  const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : fallbackDate;
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  for (const m of xml.matchAll(itemRe)) {
    const body = m[1] ?? "";
    const code = /<title>\s*([A-Z]{3})\s*<\/title>/.exec(body)?.[1];
    const value = /<description>\s*([\d.]+)\s*<\/description>/.exec(body)?.[1];
    const quant = /<quant>\s*(\d+)\s*<\/quant>/.exec(body)?.[1] ?? "1";
    if (!code || !value) continue;
    perUnit.set(code, div(parseDecimal(value), parseDecimal(quant)));
  }
  return perUnit.size > 1 ? { date, quote: "KZT", perUnit, source: "NBK" } : null;
}

const FX_FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../fixtures/fx-rates.json");
let fixtureTable: DayTable | null | undefined;

/** Track D's example table: `{base: "EUR", date, rates: {X: "decimal"}}` = X per 1 EUR. */
function loadFixtureTable(): DayTable | null {
  if (fixtureTable !== undefined) return fixtureTable;
  fixtureTable = null;
  try {
    if (existsSync(FX_FIXTURE_PATH)) {
      const raw = JSON.parse(readFileSync(FX_FIXTURE_PATH, "utf8")) as { base?: string; date?: string; rates?: Record<string, string> };
      if (raw.base === "EUR" && raw.date && raw.rates) {
        const perUnit = new Map<string, Rational>();
        for (const [c, v] of Object.entries(raw.rates)) perUnit.set(c, div(rat(1n), parseDecimal(String(v))));
        fixtureTable = { date: raw.date, quote: "EUR", perUnit, source: "STATIC_EXAMPLE" };
      }
    }
  } catch {
    fixtureTable = null;
  }
  return fixtureTable;
}

function staticTable(kzt: boolean): DayTable {
  const fx = loadFixtureTable();
  if (fx && (!kzt || fx.perUnit.has("KZT"))) return fx;
  const perUnit = new Map<string, Rational>();
  if (kzt) {
    perUnit.set("KZT", rat(1n));
    for (const [c, v] of Object.entries(STATIC_EXAMPLE.kztPer)) perUnit.set(c, parseDecimal(v));
    return { date: STATIC_EXAMPLE.date, quote: "KZT", perUnit, source: "STATIC_EXAMPLE" };
  }
  perUnit.set("EUR", rat(1n));
  for (const [c, v] of Object.entries(STATIC_EXAMPLE.eurPer)) perUnit.set(c, div(rat(1n), parseDecimal(v)));
  return { date: STATIC_EXAMPLE.date, quote: "EUR", perUnit, source: "STATIC_EXAMPLE" };
}

/** Units of `to` per 1 `from` = perUnit[from] / perUnit[to]. */
function crossRate(t: DayTable, from: string, to: string): Rational | null {
  const f = t.perUnit.get(from);
  const g = t.perUnit.get(to);
  if (!f || !g) return null;
  return div(f, g);
}

function quote(from: string, to: string, r: Rational, rateDate: string, source: RateSource): RateQuote {
  return { from, to, rate: r, rateString: toDecimalString(r), rateDate, source };
}

let defaultService: RatesService | null = null;

/** Process-wide service (daily cache). FX_OFFLINE=1 forces the labelled static table. */
export function rates(): RatesService {
  defaultService ??= new RatesService({ offline: process.env.FX_OFFLINE === "1" || process.env.NODE_ENV === "test" });
  return defaultService;
}

/** Test hook. */
export function setRatesService(s: RatesService | null): void {
  defaultService = s;
}
