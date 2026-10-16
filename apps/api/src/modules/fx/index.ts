import { and, eq, gte, isNull, lte, ne } from "drizzle-orm";

import type { ForecastResponse, ImportHistory } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { obligations, profiles, transactions, users } from "../../db/schema.ts";
import { PROFILE_CORE } from "../../db/profile-columns.ts";
import { clock } from "../clock/index.ts";
import { walletBalances } from "../rules/facts.ts";
import { addDays, isoDate } from "./dates.ts";
import { computeForecast, medianInt, type Flow } from "./forecast.ts";
import { convertMinor } from "./rational.ts";
import { rates } from "./rates.ts";
import { directRoute, getRoutes as rankRoutes, type RankedRoute } from "./routes.ts";

/*
 * Public fx API.
 */

export { RatesService, rates, setRatesService, type RateQuote, type RateSource } from "./rates.ts";
export { settlementFee, bestCard, dccFlag, rollingMedianBps } from "./fees.ts";
export { loadRails } from "./rails.ts";
export type { RankedRoute } from "./routes.ts";

function dateOf(d: Date | string): string {
  return typeof d === "string" ? d.slice(0, 10) : isoDate(d);
}

/** Mid-market home amount on `date` (purchase / due date) ±1 business day; rate as a decimal string. */
export async function toHome(
  amountMinor: number,
  currency: string,
  homeCurrency: string,
  date: Date | string,
): Promise<{ amountMinor: number; rate: string; rateDate: string; source: string }> {
  const day = dateOf(date);
  if (currency === homeCurrency) return { amountMinor, rate: "1", rateDate: day, source: "IDENTITY" };
  const q = await rates().getRate(currency, homeCurrency, day);
  return { amountMinor: convertMinor(amountMinor, currency, homeCurrency, q.rate), rate: q.rateString, rateDate: q.rateDate, source: q.source };
}

/** Wallet balances per currency (capped wallet in the mock bank, via the rules facts provider). */
export async function getBalances(userId: string): Promise<Array<{ currency: string; amountMinor: number }>> {
  return (await walletBalances(userId)) ?? [];
}

export interface GetRoutesArgs {
  userId: string;
  toCurrency: string;
  amountMinor: number;
  dueDate?: string | undefined;
  /** Only rank routes funded from this currency. */
  fromCurrency?: string | undefined;
  /** Override balances (tests / forecast suggestions). */
  balances?: Array<{ currency: string; amountMinor: number }>;
  top?: number;
}

/** Route optimizer (spec §12) for a user: balances from the wallet, home currency from the profile. */
export async function getRoutes(a: GetRoutesArgs): Promise<{ homeCurrency: string; routes: RankedRoute[] }> {
  const u = (await getDb().select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, a.userId)))[0];
  if (!u) throw new Error("user not found");
  const balances = a.balances ?? (await getBalances(a.userId));
  const req = { amountMinor: a.amountMinor, toCurrency: a.toCurrency, homeCurrency: u.homeCurrency, today: isoDate(clock.now()), dueDate: a.dueDate, balances };
  const ranked = await rankRoutes({ ...req, fundingCurrencies: a.fromCurrency ? [a.fromCurrency] : undefined, ...(a.top ? { top: a.top } : {}) });
  // Same-currency routes are direct payments (no conversion), marked as such (p1 B10).
  const routes: RankedRoute[] = ranked.map((r) => (r.fundingCurrency === a.toCurrency ? { ...r, noConversion: true, balanceCovers: true } : r));
  // Asked for the bill's own currency but the balance is short: still show the direct route, marked uncovered.
  if (a.fromCurrency === a.toCurrency && routes.length === 0) {
    const direct = await directRoute(req);
    if (direct) routes.push(direct);
  }
  return { homeCurrency: u.homeCurrency, routes };
}

/**
 * Daily spending from the imported history: the median covered month (spending + transfers to people, home currency)
 * / 30. The median keeps a tuition month or a flight out of everyday spending. Null without at least 2 covered months.
 */
export function historyDailyBurn(history: ImportHistory | null): number | null {
  const months = (history?.monthly ?? []).filter((m) => m.statements > 0).map((m) => m.spendingHomeMinor + m.transfersHomeMinor);
  if (months.length < 2) return null;
  return Math.round(medianInt(months) / 30);
}

/** Coverage forecast (spec §12) for a user, days 0..45 from Clock today. */
export async function forecastCoverage(userId: string): Promise<ForecastResponse> {
  const db = getDb();
  const now = clock.now();
  const today = isoDate(now);
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new Error("user not found");
  const p = (await db.select(PROFILE_CORE).from(profiles).where(eq(profiles.userId, userId)))[0];
  const obs = await db.select().from(obligations).where(and(eq(obligations.userId, userId), gte(obligations.dueDate, addDays(today, -31))));
  const since = new Date(now.getTime() - 31 * 86_400_000);
  const txs = await db
    .select({ currency: transactions.currency, amountMinor: transactions.amountMinor, occurredAt: transactions.occurredAt, source: transactions.source })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, since), lte(transactions.occurredAt, now), ne(transactions.source, "KASSA_PAYMENT")));

  const incomes: Flow[] = (p?.incomes ?? []).map((i) => ({ currency: i.currency, amountMinor: i.amountMinor, date: i.nextDate, cadence: i.cadence }));
  // Obligations: monthly ones may have a past due date stored (the row is the template); roll forward.
  const obligationFlows: Flow[] = obs.map((o) => ({
    currency: o.currency,
    amountMinor: o.amountMinor,
    date: o.dueDate,
    cadence: o.recurrence === "MONTHLY" ? "MONTHLY" : o.recurrence === "TERM" ? "TERM" : "ONCE",
  }));
  const reserves: Record<string, number> = {};
  for (const r of p?.reserveRules.reserves ?? []) reserves[r.currency] = r.minMinor;
  // The imported history (read on its own: a database one migration behind must not fail the forecast).
  const history = (await db.select({ h: profiles.moneyHistory }).from(profiles).where(eq(profiles.userId, userId)).catch(() => []))[0]?.h ?? null;
  const historyDaily = historyDailyBurn(history);
  return computeForecast({
    historyBurn: historyDaily && history ? { [history.homeCurrency]: historyDaily } : undefined,
    today,
    homeCurrency: u.homeCurrency,
    balances: await getBalances(userId),
    incomes,
    obligations: obligationFlows,
    // Burn = card/notification spend; Kassa payments are obligations already counted above.
    spends: txs.filter((t) => t.amountMinor > 0).map((t) => ({ currency: t.currency, amountMinor: t.amountMinor, date: isoDate(t.occurredAt) })),
    reserves,
  });
}
