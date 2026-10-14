import { monthlyIncomeOf } from "@kassa/shared";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { budgets, profiles, transactions, users } from "../../db/schema.ts";
import { clock, isoDate } from "../clock/index.ts";
import { addDays, daysBetween } from "../fx/dates.ts";
import { convertMinor } from "../fx/rational.ts";
import { rates } from "../fx/rates.ts";

/*
 * Spending context for a category, budget or not: what this month looks like so far (calendar month, UTC dates like
 * the rest of the budgets), what a usual month looked like, how much went to categories without a budget, and the
 * share of monthly income all spending used. Read-only. Used by the payment notification for a category without a
 * budget (budget.unbudgeted), the Shortcut nudge, and the agent's get_spending_summary tool.
 */

/** Months averaged for "usual" spending (full calendar months before this one, only those after the first spend). */
export const TYPICAL_MONTHS = 3;

export interface MonthWindow {
  start: string;
  end: string;
  daysTotal: number;
  daysElapsed: number;
  /** Days left including today, like budget pace. */
  daysLeft: number;
}

export function monthWindow(today: string): MonthWindow {
  const start = `${today.slice(0, 8)}01`;
  const next = `${addDays(start, 31).slice(0, 8)}01`;
  const end = addDays(next, -1);
  const daysTotal = daysBetween(start, end) + 1;
  return { start, end, daysTotal, daysElapsed: daysBetween(start, today) + 1, daysLeft: daysBetween(today, end) + 1 };
}

export const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);

export interface CategoryTotal {
  category: string;
  spentMinor: number;
  count: number;
}

export async function totalsByCategory(db: DbOrTx, userId: string, from: string, toExclusive: string): Promise<CategoryTotal[]> {
  const rows = await db
    .select({
      category: sql<string>`coalesce(${transactions.category}, 'other')`,
      total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)`,
      n: sql<string>`count(*)`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, dayStart(from)), lt(transactions.occurredAt, dayStart(toExclusive))))
    .groupBy(sql`coalesce(${transactions.category}, 'other')`);
  return rows.map((r) => ({ category: r.category, spentMinor: Number(r.total), count: Number(r.n) }));
}

/**
 * Days into a month the first recorded purchase may fall and the month still counts as tracked in full. A month whose
 * tracking started later (someone who paired on the 27th) would make a "usual month" or "last month" look tiny.
 */
export const FULL_MONTH_GRACE_DAYS = 3;

/**
 * The first calendar month that was tracked in full before `monthStart` (its first purchase within the grace days of
 * the month's start, or earlier), or null when there is none yet.
 */
export async function firstFullMonth(db: DbOrTx, userId: string, monthStart: string): Promise<string | null> {
  const first = (
    await db
      .select({ at: sql<Date | string | null>`min(${transactions.occurredAt})` })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), lt(transactions.occurredAt, dayStart(monthStart))))
  )[0]?.at;
  if (!first) return null;
  const firstDay = isoDate(new Date(first));
  const startOfFirst = `${firstDay.slice(0, 8)}01`;
  const full = daysBetween(startOfFirst, firstDay) < FULL_MONTH_GRACE_DAYS ? startOfFirst : `${addDays(startOfFirst, 31).slice(0, 8)}01`;
  return full < monthStart ? full : null;
}

/** Average monthly spend per category over the last TYPICAL_MONTHS months before this one that were tracked in full. */
export async function typicalByCategory(db: DbOrTx, userId: string, monthStart: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const firstMonth = await firstFullMonth(db, userId, monthStart);
  if (!firstMonth) return out;
  let from = monthStart;
  let months = 0;
  while (months < TYPICAL_MONTHS) {
    const prev = `${addDays(from, -1).slice(0, 8)}01`;
    if (prev < firstMonth) break;
    from = prev;
    months += 1;
  }
  if (months === 0) return out;
  for (const t of await totalsByCategory(db, userId, from, monthStart)) out.set(t.category, Math.round(t.spentMinor / months));
  return out;
}

/** Monthly income in the home currency (weekly × 52 / 12, a term grant over six months, one-offs left out). */
export async function monthlyIncome(db: DbOrTx, userId: string, homeCurrency: string, today: string): Promise<number | null> {
  const p = (await db.select({ incomes: profiles.incomes }).from(profiles).where(eq(profiles.userId, userId)))[0];
  if (!p || p.incomes.length === 0) return null;
  let total = 0;
  for (const i of p.incomes) {
    const monthly = monthlyIncomeOf(i.amountMinor, i.cadence);
    if (monthly <= 0) continue;
    if (i.currency === homeCurrency) total += monthly;
    else {
      try {
        total += convertMinor(monthly, i.currency, homeCurrency, (await rates().getRate(i.currency, homeCurrency, today)).rate);
      } catch {
        // No rate for this currency today: leave that income out rather than guess.
      }
    }
  }
  return total > 0 ? total : null;
}

export interface CategorySpend extends CategoryTotal {
  budgeted: boolean;
  /** Average of recent full months; null for a new user or a category never spent in before. */
  typicalMinor: number | null;
}

export interface SpendContext {
  homeCurrency: string;
  month: MonthWindow;
  /** The category asked about (zero when nothing was spent in it this month). */
  category: CategorySpend;
  /** Every category spent in this month, most spent first. */
  categories: CategorySpend[];
  /** This month's spending in categories without an active budget. */
  outsideBudgetsMinor: number;
  totalMinor: number;
  monthlyIncomeMinor: number | null;
  /** totalMinor as a share of monthly income (integer percent), when the income is known. */
  incomeUsedPct: number | null;
}

export async function spendContext(userId: string, category: string, db: DbOrTx = getDb()): Promise<SpendContext> {
  const today = isoDate(clock.now());
  const month = monthWindow(today);
  const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
  const homeCurrency = u?.homeCurrency ?? "KZT";
  const active = await db
    .select({ category: budgets.category })
    .from(budgets)
    .where(and(eq(budgets.userId, userId), sql`${budgets.periodStart} <= ${today}`, sql`${budgets.periodEnd} >= ${today}`));
  const budgeted = new Set(active.map((b) => b.category));
  const totals = await totalsByCategory(db, userId, month.start, addDays(month.end, 1));
  const typical = await typicalByCategory(db, userId, month.start);
  const withMeta = (t: CategoryTotal): CategorySpend => ({ ...t, budgeted: budgeted.has(t.category), typicalMinor: typical.get(t.category) ?? null });
  const categories = totals.map(withMeta).sort((a, b) => b.spentMinor - a.spentMinor || a.category.localeCompare(b.category));
  const totalMinor = totals.reduce((a, t) => a + t.spentMinor, 0);
  const outsideBudgetsMinor = categories.filter((c) => !c.budgeted).reduce((a, c) => a + c.spentMinor, 0);
  const monthlyIncomeMinor = await monthlyIncome(db, userId, homeCurrency, today);
  return {
    homeCurrency,
    month,
    category: categories.find((c) => c.category === category) ?? withMeta({ category, spentMinor: 0, count: 0 }),
    categories,
    outsideBudgetsMinor,
    totalMinor,
    monthlyIncomeMinor,
    incomeUsedPct: monthlyIncomeMinor ? Math.floor((totalMinor * 100) / monthlyIncomeMinor) : null,
  };
}
