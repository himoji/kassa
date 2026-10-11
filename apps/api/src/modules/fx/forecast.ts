import type { ForecastResponse } from "@kassa/shared";

import { addDays, daysBetween } from "./dates.ts";
import { roundHalfUp, rat, toSafeNumber } from "./rational.ts";
import { getRoutes } from "./routes.ts";
import { rates, type RatesService } from "./rates.ts";

/*
 * Coverage forecast (spec §12):
 *   B_k(t) = B_k(0) + incomes_k(≤t) − obligations_k(≤t) − burn_k·t,   t = 0..45 days
 *   burn_k = median daily spend in k over the last 30 days (days without spend count as 0)
 *   shortfall = first day B_k < reserve_k; suggest a conversion from the surplus currency via the
 *   route optimizer.
 */

export const HORIZON_DAYS = 45;

export type Cadence = "WEEKLY" | "MONTHLY" | "TERM" | "ONCE";

export interface Flow {
  currency: string;
  amountMinor: number;
  /** First occurrence (ISO date). */
  date: string;
  cadence: Cadence;
}

export interface ForecastInput {
  today: string;
  homeCurrency: string;
  balances: Array<{ currency: string; amountMinor: number }>;
  incomes: Flow[];
  obligations: Flow[];
  /** Individual spends (positive minor units) with ISO date; only the last 30 days are used. */
  spends: Array<{ currency: string; amountMinor: number; date: string }>;
  /** Protected reserve per currency (minor units); default 0. */
  reserves?: Record<string, number>;
  horizonDays?: number;
}

/** Add calendar months, clamping to the month's last day (ISO 8601 calendar arithmetic). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** All occurrences of a flow in [from, to]. TERM = every 4 months (academic term, approximation). */
export function occurrences(flow: Flow, from: string, to: string): string[] {
  const out: string[] = [];
  let d = flow.date;
  let i = 0;
  const next = (n: number): string =>
    flow.cadence === "WEEKLY" ? addDays(flow.date, 7 * n) : flow.cadence === "MONTHLY" ? addMonths(flow.date, n) : addMonths(flow.date, 4 * n);
  while (d <= to && i < 1000) {
    if (d >= from) out.push(d);
    if (flow.cadence === "ONCE") break;
    i++;
    d = next(i);
  }
  return out;
}

/** Median of integers; even count → mean of the middle two, rounded half-up. */
export function medianInt(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2) return s[mid]!;
  return toSafeNumber(roundHalfUp(rat(BigInt(s[mid - 1]!) + BigInt(s[mid]!), 2n)));
}

export function burnRate(spends: ForecastInput["spends"], currency: string, today: string): number {
  const daily = new Array<number>(30).fill(0);
  for (const s of spends) {
    if (s.currency !== currency) continue;
    const ago = daysBetween(s.date, today);
    if (ago >= 1 && ago <= 30) daily[ago - 1]! += s.amountMinor;
  }
  return medianInt(daily);
}

export interface CurrencyProjection {
  currency: string;
  reserveMinor: number;
  points: Array<{ date: string; balanceMinor: number }>;
  shortfall: { date: string; amountMinor: number } | null;
  /** reserve − min balance over the horizon, when positive (the amount needed to stay above reserve). */
  maxDeficitMinor: number;
  minSurplusMinor: number;
}

export function projectBalances(input: ForecastInput): CurrencyProjection[] {
  const horizon = input.horizonDays ?? HORIZON_DAYS;
  const end = addDays(input.today, horizon);
  const currencies = new Set<string>([
    ...input.balances.map((b) => b.currency),
    ...input.incomes.map((f) => f.currency),
    ...input.obligations.map((f) => f.currency),
  ]);
  const out: CurrencyProjection[] = [];
  for (const k of [...currencies].sort()) {
    const deltas = new Map<string, number>();
    const bump = (d: string, v: number) => deltas.set(d, (deltas.get(d) ?? 0) + v);
    for (const f of input.incomes) if (f.currency === k) for (const d of occurrences(f, input.today, end)) bump(d, f.amountMinor);
    for (const f of input.obligations) if (f.currency === k) for (const d of occurrences(f, input.today, end)) bump(d, -f.amountMinor);
    const burn = burnRate(input.spends, k, input.today);
    const reserve = input.reserves?.[k] ?? 0;
    let flows = input.balances.find((b) => b.currency === k)?.amountMinor ?? 0;
    const points: CurrencyProjection["points"] = [];
    let shortfall: CurrencyProjection["shortfall"] = null;
    let minBalance = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= horizon; t++) {
      const date = addDays(input.today, t);
      flows += deltas.get(date) ?? 0;
      const b = flows - burn * t;
      points.push({ date, balanceMinor: b });
      minBalance = Math.min(minBalance, b);
      if (!shortfall && b < reserve) shortfall = { date, amountMinor: reserve - b };
    }
    out.push({
      currency: k,
      reserveMinor: reserve,
      points,
      shortfall,
      maxDeficitMinor: Math.max(0, reserve - minBalance),
      minSurplusMinor: minBalance - reserve,
    });
  }
  return out;
}

/** Full forecast with conversion suggestions (async: uses rates + route optimizer). */
export async function computeForecast(input: ForecastInput, svc: RatesService = rates()): Promise<ForecastResponse> {
  const proj = projectBalances(input);
  const suggestions: ForecastResponse["suggestions"] = [];
  // Surplus currencies ranked by home-value surplus (minimum over the horizon above reserve).
  const surplusHome: Array<{ currency: string; surplusMinor: number; home: number }> = [];
  for (const p of proj) {
    if (p.minSurplusMinor <= 0) continue;
    const home = p.currency === input.homeCurrency ? p.minSurplusMinor : (await svc.convert(p.minSurplusMinor, p.currency, input.homeCurrency, input.today)).amountMinor;
    surplusHome.push({ currency: p.currency, surplusMinor: p.minSurplusMinor, home });
  }
  surplusHome.sort((a, b) => b.home - a.home);
  for (const p of proj) {
    if (!p.shortfall || p.maxDeficitMinor <= 0) continue;
    for (const s of surplusHome) {
      if (s.currency === p.currency) continue;
      const need = (await svc.convert(p.maxDeficitMinor, p.currency, s.currency, input.today)).amountMinor;
      if (need > s.surplusMinor) continue;
      const routes = await getRoutes(
        {
          amountMinor: p.maxDeficitMinor,
          toCurrency: p.currency,
          homeCurrency: input.homeCurrency,
          today: input.today,
          dueDate: p.shortfall.date,
          balances: [{ currency: s.currency, amountMinor: s.surplusMinor }],
          top: 1,
        },
        svc,
      );
      const best = routes[0];
      suggestions.push({
        fromCurrency: s.currency,
        toCurrency: p.currency,
        amountMinor: p.maxDeficitMinor,
        byDate: p.shortfall.date,
        route: best
          ? (({ amountInFundingMinor: _a, totalDebitFundingMinor: _t, ...dto }) => dto)(best)
          : null,
      });
      break;
    }
  }
  return {
    horizonDays: input.horizonDays ?? HORIZON_DAYS,
    asOf: input.today,
    currencies: proj.map((p) => ({ currency: p.currency, reserveMinor: p.reserveMinor, points: p.points, shortfall: p.shortfall })),
    suggestions,
  };
}
