import { and, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";

import type { BudgetDto, BudgetImpact, BudgetsResponse } from "@kassa/shared";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { budgets, notifications, profiles, transactions, users } from "../../db/schema.ts";
import { clock, isoDate } from "../clock/index.ts";
import { notify } from "../notifications/service.ts";
import { addDays } from "../fx/dates.ts";
import { zoneFor } from "../rules/facts.ts";
import { crossedThresholds, renderEn, type BudgetMessage, type MoneyParam } from "./messages.ts";
import { computePace } from "./pace.ts";

/*
 * Budgets (spec §13): spending per category = Σ homeAmountMinor of the user's unmerged transactions in
 * the budget period (UTC calendar dates, like the rest of the API). Notifications per profile mode.
 */

const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);

export async function spentInPeriod(db: DbOrTx, userId: string, category: string, periodStart: string, periodEnd: string): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.homeAmountMinor}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.category, category),
        isNull(transactions.mergedIntoId),
        gte(transactions.occurredAt, dayStart(periodStart)),
        lt(transactions.occurredAt, dayStart(addDays(periodEnd, 1))),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

async function activeBudgets(db: DbOrTx, userId: string, today: string, category?: string) {
  return db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.userId, userId),
        lte(budgets.periodStart, today),
        gte(budgets.periodEnd, today),
        category ? eq(budgets.category, category) : undefined,
      ),
    );
}

export async function listBudgets(userId: string, category?: string, db: DbOrTx = getDb()): Promise<BudgetsResponse> {
  const today = isoDate(clock.now());
  const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
  const rows = await activeBudgets(db, userId, today, category);
  const out: BudgetDto[] = [];
  for (const b of rows) {
    const spent = await spentInPeriod(db, userId, b.category, b.periodStart, b.periodEnd);
    const p = computePace({ limitHomeMinor: b.limitHomeMinor, spentHomeMinor: spent, periodStart: b.periodStart, periodEnd: b.periodEnd, today });
    out.push({
      id: b.id,
      category: b.category,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      limitHomeMinor: b.limitHomeMinor,
      spentHomeMinor: spent,
      remainingHomeMinor: p.remainingHomeMinor,
      daysLeft: p.daysLeft,
      pace: p.pace,
      projectedRunOutDate: p.projectedRunOutDate,
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category));
  return { homeCurrency: u?.homeCurrency ?? "KZT", budgets: out };
}

/** Budget impact of spending `homeAmountMinor` in `category` (chat cards; null = no budget). */
export async function budgetImpact(userId: string, category: string, homeAmountMinor: number, db: DbOrTx = getDb()): Promise<BudgetImpact | null> {
  const r = await listBudgets(userId, category, db);
  const b = r.budgets[0];
  if (!b) return null;
  return {
    category,
    homeCurrency: r.homeCurrency,
    limitHomeMinor: b.limitHomeMinor,
    remainingBeforeHomeMinor: b.remainingHomeMinor,
    remainingAfterHomeMinor: b.remainingHomeMinor - homeAmountMinor,
    daysLeft: b.daysLeft,
  };
}

async function alreadySent(db: DbOrTx, userId: string, kind: string, key: string): Promise<boolean> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind), sql`${notifications.data}->>'dedupeKey' = ${key}`))
    .limit(1);
  return rows.length > 0;
}

async function send(db: DbOrTx, userId: string, kind: string, msg: BudgetMessage, extra: Record<string, unknown> = {}) {
  const en = renderEn(msg);
  return notify(userId, { kind, title: en.title, body: en.body, data: { key: msg.key, params: msg.params, ...extra } }, db);
}

export interface LoggedSpend {
  transactionId: string;
  category: string;
  homeAmountMinor: number;
  merchantDisplay: string;
  amount: MoneyParam;
}

/**
 * Called after a captured spend is stored (spec §13 "Budget update and notification").
 * EACH: one message per spend; THRESHOLDS: 50/80/100 % crossings (once per budget period);
 * DIGEST: nothing now (sendDigestIfDue at 20:00).
 */
export async function onSpendLogged(userId: string, s: LoggedSpend, db: DbOrTx = getDb()): Promise<BudgetMessage | null> {
  const today = isoDate(clock.now());
  const p = (await db.select({ mode: profiles.notificationMode }).from(profiles).where(eq(profiles.userId, userId)))[0];
  const mode = p?.mode ?? "EACH";
  const b = (await activeBudgets(db, userId, today, s.category))[0];
  if (!b) return null;
  const spentAfter = await spentInPeriod(db, userId, s.category, b.periodStart, b.periodEnd);
  const after = computePace({ limitHomeMinor: b.limitHomeMinor, spentHomeMinor: spentAfter, periodStart: b.periodStart, periodEnd: b.periodEnd, today });
  if (mode === "EACH") {
    const msg: BudgetMessage = {
      key: "budget.each",
      params: { amount: s.amount, merchant: s.merchantDisplay, category: s.category, usedPct: after.usedPct, leftPct: after.leftPct, days: after.daysLeft, pace: after.pace },
    };
    await send(db, userId, "BUDGET_EACH", msg, { transactionId: s.transactionId, budgetId: b.id });
    return msg;
  }
  if (mode === "THRESHOLDS") {
    const before = computePace({ limitHomeMinor: b.limitHomeMinor, spentHomeMinor: spentAfter - s.homeAmountMinor, periodStart: b.periodStart, periodEnd: b.periodEnd, today });
    const crossed = crossedThresholds(before.usedPct, after.usedPct);
    const top = crossed[crossed.length - 1];
    if (top === undefined) return null;
    const dedupeKey = `threshold:${b.id}:${b.periodStart}:${top}`;
    if (await alreadySent(db, userId, "BUDGET_THRESHOLD", dedupeKey)) return null;
    const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
    const msg: BudgetMessage = {
      key: "budget.threshold",
      params: { category: s.category, threshold: top, usedPct: after.usedPct, remaining: { amountMinor: Math.max(0, after.remainingHomeMinor), currency: u?.homeCurrency ?? "KZT" }, days: after.daysLeft },
    };
    await send(db, userId, "BUDGET_THRESHOLD", msg, { dedupeKey, budgetId: b.id });
    return msg;
  }
  return null;
}

export const DIGEST_HOUR = 20;

function localParts(now: Date, zone: string): { date: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
}

/**
 * Digest mode (spec §13): one daily summary at 20:00 local (Clock). Idempotent per local date.
 * The scheduler (A) calls this every tick; returns true when a digest was sent.
 */
export async function sendDigestIfDue(userId: string, db: DbOrTx = getDb()): Promise<boolean> {
  const now = clock.now();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  const p = (await db.select({ mode: profiles.notificationMode }).from(profiles).where(eq(profiles.userId, userId)))[0];
  if (!u || p?.mode !== "DIGEST") return false;
  const local = localParts(now, zoneFor(u.region));
  if (local.hour < DIGEST_HOUR) return false;
  const dedupeKey = `digest:${local.date}`;
  if (await alreadySent(db, userId, "BUDGET_DIGEST", dedupeKey)) return false;
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const todays = await db
    .select({ home: transactions.homeAmountMinor })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, since), lte(transactions.occurredAt, now)))
    .orderBy(desc(transactions.occurredAt));
  const spentToday = todays.reduce((a, t) => a + (t.home ?? 0), 0);
  const bs = await listBudgets(userId, undefined, db);
  const msg: BudgetMessage = {
    key: "budget.digest",
    params: {
      date: local.date,
      spentToday: { amountMinor: spentToday, currency: u.homeCurrency },
      transactions: todays.length,
      categories: bs.budgets.map((b) => {
        const used = b.limitHomeMinor > 0 ? Math.floor((b.spentHomeMinor * 100) / b.limitHomeMinor) : 100;
        return { category: b.category, usedPct: used, leftPct: Math.max(0, 100 - used), pace: b.pace };
      }),
    },
  };
  await send(db, userId, "BUDGET_DIGEST", msg, { dedupeKey });
  return true;
}
