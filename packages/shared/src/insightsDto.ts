import { z } from "zod";

import { TransactionDto } from "./dto.ts";
import { BudgetPace } from "./enums.ts";
import { AmountMinor, CurrencyCode, IsoDate, IsoDateTime, Uuid } from "./primitives.ts";

/*
 * Spending insights (GET /insights/spending) and one purchase in detail (GET /transactions/:id). Read-only views the
 * apps draw from; every amount is computed by the server in the home currency, so the apps never add up money.
 */

const Count = z.number().int().nonnegative();

/** An active budget's state, the same numbers as GET /budgets. */
export const BudgetState = z.object({
  limitMinor: AmountMinor,
  spentMinor: AmountMinor,
  remainingMinor: AmountMinor,
  daysLeft: Count,
  pace: BudgetPace,
});
export type BudgetState = z.infer<typeof BudgetState>;

export const CategoryInsight = z.object({
  category: z.string(),
  spentMinor: AmountMinor,
  count: Count,
  /** Average of recent full months; null for a new user or a category never spent in before. */
  typicalMinor: AmountMinor.nullable(),
  /** Share of this month's total (integer percent). */
  sharePct: z.number().int().min(0).max(100),
  budget: BudgetState.nullable(),
});
export type CategoryInsight = z.infer<typeof CategoryInsight>;

export const MonthWindowDto = z.object({
  start: IsoDate,
  end: IsoDate,
  daysTotal: Count,
  daysElapsed: Count,
  daysLeft: Count,
});
export type MonthWindowDto = z.infer<typeof MonthWindowDto>;

/** GET /insights/spending: this calendar month so far, against last month and a usual month. */
export const SpendingInsightsResponse = z.object({
  homeCurrency: CurrencyCode,
  month: MonthWindowDto,
  totalMinor: AmountMinor,
  count: Count,
  /** Last month up to the same day of the month; null unless last month was tracked in full (from its first days). */
  lastMonthToDateMinor: AmountMinor.nullable(),
  lastMonthTotalMinor: AmountMinor.nullable(),
  /** Average month over the last three tracked in full; null when there is none yet. */
  typicalMonthMinor: AmountMinor.nullable(),
  /** Where this month ends: spent so far plus the days left at the recent daily pace (the biggest day left out). */
  projectedMinor: AmountMinor,
  monthlyIncomeMinor: AmountMinor.nullable(),
  /** totalMinor as a share of monthly income (integer percent), when the income is known. */
  incomeUsedPct: z.number().int().nullable(),
  /** Spending in categories without an active budget. */
  outsideBudgetsMinor: AmountMinor,
  /** One entry per day from the 1st to today (zero days included). */
  daily: z.array(z.object({ date: IsoDate, spentMinor: AmountMinor })),
  /** Most spent first. */
  categories: z.array(CategoryInsight),
  /** Up to five, most spent first. */
  topMerchants: z.array(z.object({ name: z.string(), spentMinor: AmountMinor, count: Count })),
});
export type SpendingInsightsResponse = z.infer<typeof SpendingInsightsResponse>;

/** GET /transactions/:id: one purchase, where it was, and what it means for the month. */
export const TransactionDetailResponse = z.object({
  transaction: TransactionDto,
  /** The name people recognise (the likely place, or the statement name with the processor moved aside). */
  merchant: z.string(),
  place: z
    .object({
      name: z.string().optional(),
      kind: z.string().optional(),
      where: z.string().optional(),
      processor: z.string().optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
    })
    .nullable(),
  card: z.object({ label: z.string(), last4: z.string() }).nullable(),
  homeCurrency: CurrencyCode,
  /** This month in the purchase's category; null for a purchase without a category. */
  category: z
    .object({
      category: z.string(),
      spentThisMonthMinor: AmountMinor,
      countThisMonth: Count,
      typicalMinor: AmountMinor.nullable(),
      /** Share of this month's total spending (integer percent). */
      shareOfMonthPct: z.number().int().min(0).max(100),
      budget: BudgetState.nullable(),
    })
    .nullable(),
  /** Every purchase at the same merchant (this one included). */
  merchantHistory: z.object({
    visits: Count,
    totalMinor: AmountMinor,
    averageMinor: AmountMinor,
    firstAt: IsoDateTime,
    /** Up to five earlier visits, newest first. */
    recent: z.array(z.object({ id: Uuid, occurredAt: IsoDateTime, amountMinor: AmountMinor, currency: CurrencyCode })),
  }),
});
export type TransactionDetailResponse = z.infer<typeof TransactionDetailResponse>;
