import type { BudgetState, SpendingInsightsResponse, TransactionDetailResponse } from "@kassa/shared";
import { and, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { cards, transactions, users } from "../../db/schema.ts";
import { placeName } from "../capture/service.ts";
import { whereLabel } from "../capture/place.ts";
import { clock, isoDate } from "../clock/index.ts";
import { addDays } from "../fx/dates.ts";
import { toTransactionDto } from "../money/transaction-dto.ts";
import { dayStart, firstFullMonth, monthlyIncome, monthWindow, totalsByCategory, typicalByCategory } from "./context.ts";
import { listBudgets } from "./service.ts";

/*
 * Read-only views for the apps (GET /insights/spending, GET /transactions/:id): this month by category and by day,
 * against last month and a usual month, and one purchase with what it means for the month. Same rules as
 * context.ts: calendar months on UTC dates, home-currency amounts (rows without a home amount are left out of sums).
 */

const TOP_MERCHANTS = 5;
const RECENT_VISITS = 5;

const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.max(0, Math.floor((part * 100) / whole))) : 0);

async function homeCurrencyOf(db: DbOrTx, userId: string): Promise<string> {
  const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
  return u?.homeCurrency ?? "KZT";
}

async function budgetStates(db: DbOrTx, userId: string, category?: string): Promise<Map<string, BudgetState>> {
  const r = await listBudgets(userId, category, db);
  return new Map(
    r.budgets.map((b) => [
      b.category,
      { limitMinor: b.limitHomeMinor, spentMinor: b.spentHomeMinor, remainingMinor: b.remainingHomeMinor, daysLeft: b.daysLeft, pace: b.pace },
    ]),
  );
}

async function sumBetween(db: DbOrTx, userId: string, from: string, toExclusive: string): Promise<number> {
  const r = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, dayStart(from)), lt(transactions.occurredAt, dayStart(toExclusive))));
  return Number(r[0]?.total ?? 0);
}

/** Days of recent spending the month-end projection is paced on. */
export const PACE_DAYS = 14;

/**
 * Where the month ends at the recent pace: what is spent so far plus the days left at the average of the last
 * PACE_DAYS days. With a week or more to go on, the single biggest day is left out of the pace, so rent paid on the
 * 1st or one big purchase is counted once and not repeated for every remaining day.
 */
export function projectMonth(daily: readonly { spentMinor: number }[], totalMinor: number, daysLeftAfterToday: number): number {
  const window = daily.slice(-PACE_DAYS).map((d) => d.spentMinor);
  if (window.length === 0 || daysLeftAfterToday <= 0) return totalMinor;
  if (window.length >= 7) window.splice(window.indexOf(Math.max(...window)), 1);
  const pace = window.reduce((a, v) => a + v, 0) / window.length;
  return totalMinor + Math.round(pace * daysLeftAfterToday);
}

export async function spendingInsights(userId: string, db: DbOrTx = getDb()): Promise<SpendingInsightsResponse> {
  const today = isoDate(clock.now());
  const month = monthWindow(today);
  const tomorrow = addDays(today, 1);
  const homeCurrency = await homeCurrencyOf(db, userId);

  const totals = await totalsByCategory(db, userId, month.start, tomorrow);
  const totalMinor = totals.reduce((a, t) => a + t.spentMinor, 0);
  const count = totals.reduce((a, t) => a + t.count, 0);
  const typical = await typicalByCategory(db, userId, month.start);
  const budgets = await budgetStates(db, userId);

  const byCategory = new Map(totals.map((t) => [t.category, t]));
  for (const category of budgets.keys()) if (!byCategory.has(category)) byCategory.set(category, { category, spentMinor: 0, count: 0 });
  const categories = [...byCategory.values()]
    .map((t) => ({
      category: t.category,
      spentMinor: t.spentMinor,
      count: t.count,
      typicalMinor: typical.get(t.category) ?? null,
      sharePct: pct(t.spentMinor, totalMinor),
      budget: budgets.get(t.category) ?? null,
    }))
    .sort((a, b) => b.spentMinor - a.spentMinor || a.category.localeCompare(b.category));
  const outsideBudgetsMinor = categories.filter((c) => !c.budget).reduce((a, c) => a + c.spentMinor, 0);

  // Last month: whole, and up to the same day of the month (a short month stops at its last day).
  // Only against a month that was tracked in full: one that started on the 27th would make any month look huge.
  const prev = monthWindow(addDays(month.start, -1));
  const fullFrom = await firstFullMonth(db, userId, month.start);
  const hadHistory = fullFrom !== null && fullFrom <= prev.start;
  const prevToDateEnd = addDays(prev.start, Math.min(month.daysElapsed, prev.daysTotal));
  const lastMonthToDateMinor = hadHistory ? await sumBetween(db, userId, prev.start, prevToDateEnd) : null;
  const lastMonthTotalMinor = hadHistory ? await sumBetween(db, userId, prev.start, month.start) : null;
  const typicalMonthMinor = typical.size > 0 ? [...typical.values()].reduce((a, v) => a + v, 0) : null;

  const dayRows = await db
    .select({
      day: sql<string>`to_char(${transactions.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, dayStart(month.start)), lt(transactions.occurredAt, dayStart(tomorrow))))
    .groupBy(sql`1`);
  const perDay = new Map(dayRows.map((r) => [r.day, Number(r.total)]));
  const daily: SpendingInsightsResponse["daily"] = [];
  for (let d = month.start; d <= today; d = addDays(d, 1)) daily.push({ date: d, spentMinor: perDay.get(d) ?? 0 });

  const merchantRows = await db
    .select({
      norm: transactions.merchantNorm,
      raw: sql<string>`max(${transactions.merchantRaw})`,
      place: sql<string | null>`max(${transactions.place}->>'name')`,
      total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)`,
      n: sql<string>`count(*)`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, dayStart(month.start)), lt(transactions.occurredAt, dayStart(tomorrow))))
    .groupBy(transactions.merchantNorm)
    .orderBy(sql`4 desc`, transactions.merchantNorm)
    .limit(TOP_MERCHANTS);
  const topMerchants = [];
  for (const m of merchantRows) {
    const name = m.place ?? (await placeName(userId, m.norm, m.raw, db)).name;
    topMerchants.push({ name, spentMinor: Number(m.total), count: Number(m.n) });
  }

  const monthlyIncomeMinor = await monthlyIncome(db, userId, homeCurrency, today);
  return {
    homeCurrency,
    month,
    totalMinor,
    count,
    lastMonthToDateMinor,
    lastMonthTotalMinor,
    typicalMonthMinor,
    projectedMinor: projectMonth(daily, totalMinor, month.daysLeft - 1),
    monthlyIncomeMinor,
    incomeUsedPct: monthlyIncomeMinor ? Math.floor((totalMinor * 100) / monthlyIncomeMinor) : null,
    outsideBudgetsMinor,
    daily,
    categories,
    topMerchants,
  };
}

/** One of the caller's transactions with its month context; 404 when it is not theirs (the caller checks ownership). */
export async function transactionDetail(userId: string, id: string, db: DbOrTx = getDb()): Promise<TransactionDetailResponse | null> {
  const row = (await db.select().from(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId))))[0];
  if (!row) return null;
  const homeCurrency = await homeCurrencyOf(db, userId);
  const today = isoDate(clock.now());
  const month = monthWindow(today);
  const tomorrow = addDays(today, 1);

  const merchant = row.place?.name ?? (await placeName(userId, row.merchantNorm, row.merchantRaw, db)).name;
  const p = row.place;
  const where = whereLabel(p);
  const place = p
    ? {
        ...(p.name ? { name: p.name } : {}),
        ...(p.kind ? { kind: p.kind } : {}),
        ...(where ? { where } : {}),
        ...(p.processor ? { processor: p.processor } : {}),
        ...(p.lat !== undefined && p.lon !== undefined ? { lat: p.lat, lon: p.lon } : {}),
      }
    : null;

  const card = row.cardId ? ((await db.select({ label: cards.label, last4: cards.last4 }).from(cards).where(eq(cards.id, row.cardId)))[0] ?? null) : null;

  let category: TransactionDetailResponse["category"] = null;
  if (row.category) {
    const totals = await totalsByCategory(db, userId, month.start, tomorrow);
    const monthTotal = totals.reduce((a, t) => a + t.spentMinor, 0);
    const mine = totals.find((t) => t.category === row.category);
    const typical = await typicalByCategory(db, userId, month.start);
    const budgets = await budgetStates(db, userId, row.category);
    category = {
      category: row.category,
      spentThisMonthMinor: mine?.spentMinor ?? 0,
      countThisMonth: mine?.count ?? 0,
      typicalMinor: typical.get(row.category) ?? null,
      shareOfMonthPct: pct(mine?.spentMinor ?? 0, monthTotal),
      budget: budgets.get(row.category) ?? null,
    };
  }

  const sameMerchant = and(eq(transactions.userId, userId), eq(transactions.merchantNorm, row.merchantNorm), isNull(transactions.mergedIntoId));
  const agg = (
    await db
      .select({
        n: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)`,
        first: sql<Date | string>`min(${transactions.occurredAt})`,
      })
      .from(transactions)
      .where(sameMerchant)
  )[0];
  const visits = Number(agg?.n ?? 0);
  const totalMinor = Number(agg?.total ?? 0);
  const recent = await db
    .select({ id: transactions.id, occurredAt: transactions.occurredAt, amountMinor: transactions.amountMinor, currency: transactions.currency })
    .from(transactions)
    .where(and(sameMerchant, ne(transactions.id, row.id)))
    .orderBy(desc(transactions.occurredAt))
    .limit(RECENT_VISITS);

  return {
    transaction: toTransactionDto(row),
    merchant,
    place,
    card,
    homeCurrency,
    category,
    merchantHistory: {
      visits,
      totalMinor,
      averageMinor: visits > 0 ? Math.round(totalMinor / visits) : 0,
      firstAt: agg?.first ? new Date(agg.first).toISOString() : row.occurredAt.toISOString(),
      recent: recent.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() })),
    },
  };
}
