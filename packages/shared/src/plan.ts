/*
 * Savings-plan arithmetic shared by the app's "your rules" planner and POST /plan/advice: what is left each month
 * after fixed bills and budgets, where that leaves a savings goal, and a deterministic way to trim the flexible budgets
 * when the goal does not fit. Integer minor units throughout.
 */
import type { IncomeCadence } from "./enums.ts";

/** Budgets the plan never trims on its own: rent, tuition and the like are bills, not spending choices. */
export const FIXED_BUDGET_CATEGORIES: ReadonlySet<string> = new Set(["rent", "housing", "tuition", "education", "insurance", "utilities", "health"]);

/** A flexible budget is trimmed by at most this share of its limit. */
export const MAX_TRIM_SHARE = 0.5;

/** One income per month: weekly pay × 52 / 12, a term grant spread over six months, a one-off not counted. */
export function monthlyIncomeOf(amountMinor: number, cadence: IncomeCadence): number {
  switch (cadence) {
    case "WEEKLY":
      return Math.round((amountMinor * 52) / 12);
    case "MONTHLY":
      return amountMinor;
    case "TERM":
      return Math.round(amountMinor / 6);
    case "ONCE":
      return 0;
  }
}

export interface PlanInput {
  monthlyIncomeMinor: number;
  fixedMonthlyMinor: number;
  budgets: readonly { category: string; limitHomeMinor: number }[];
  goal: { amountMinor: number; months: number } | null;
  /** Months to project over when there is no goal yet (the planner's month choice); the goal's months win. */
  months?: number;
}

export interface PlanOutcome {
  budgetsTotalMinor: number;
  /** Income − fixed bills − budgets (negative when the month does not add up). */
  monthlyLeftMinor: number;
  /** Saved after `goal.months` at that pace (0 when nothing is left). */
  projectedMinor: number;
  /** What the goal needs per month (0 without a goal). */
  neededPerMonthMinor: number;
  /** Months the goal takes at that pace; null when nothing is left to save. */
  monthsToGoal: number | null;
  goalReached: boolean;
}

export function planOutcome(p: PlanInput): PlanOutcome {
  const budgetsTotalMinor = p.budgets.reduce((s, b) => s + b.limitHomeMinor, 0);
  const monthlyLeftMinor = p.monthlyIncomeMinor - p.fixedMonthlyMinor - budgetsTotalMinor;
  const months = p.goal?.months ?? p.months ?? 0;
  const projectedMinor = Math.max(0, monthlyLeftMinor) * months;
  const neededPerMonthMinor = p.goal ? Math.ceil(p.goal.amountMinor / p.goal.months) : 0;
  const monthsToGoal = p.goal && monthlyLeftMinor > 0 ? Math.ceil(p.goal.amountMinor / monthlyLeftMinor) : null;
  return {
    budgetsTotalMinor,
    monthlyLeftMinor,
    projectedMinor,
    neededPerMonthMinor,
    monthsToGoal,
    goalReached: !!p.goal && projectedMinor >= p.goal.amountMinor,
  };
}

/** A round step for an amount: a power of ten about a tenth of it (the app's slider step). */
function roundStep(minor: number): number {
  return 10 ** Math.floor(Math.log10(Math.max(1, minor / 10)));
}

/**
 * The deterministic suggestion: the monthly gap to the goal, taken from the flexible budgets in proportion to their
 * size, each by at most MAX_TRIM_SHARE and in round steps. Returns only the categories that change.
 */
export function trimBudgetsForGoal(p: PlanInput): { category: string; limitHomeMinor: number }[] {
  const out = planOutcome(p);
  const gap = out.neededPerMonthMinor - out.monthlyLeftMinor;
  if (!p.goal || gap <= 0) return [];
  const flexible = p.budgets.filter((b) => !FIXED_BUDGET_CATEGORIES.has(b.category) && b.limitHomeMinor > 1);
  const flexTotal = flexible.reduce((s, b) => s + b.limitHomeMinor, 0);
  if (flexTotal === 0) return [];
  const changes: { category: string; limitHomeMinor: number }[] = [];
  for (const b of flexible) {
    const step = roundStep(b.limitHomeMinor);
    const maxCut = Math.floor((b.limitHomeMinor * MAX_TRIM_SHARE) / step) * step;
    const share = Math.ceil((gap * b.limitHomeMinor) / flexTotal / step) * step;
    const cut = Math.min(maxCut, share);
    if (cut > 0) changes.push({ category: b.category, limitHomeMinor: b.limitHomeMinor - cut });
  }
  return changes;
}

/** `budgets` with `changes` applied by category. */
export function withBudgetChanges<T extends { category: string; limitHomeMinor: number }>(
  budgets: readonly T[],
  changes: readonly { category: string; limitHomeMinor: number }[],
): T[] {
  const byCategory = new Map(changes.map((c) => [c.category, c.limitHomeMinor]));
  return budgets.map((b) => ({ ...b, limitHomeMinor: byCategory.get(b.category) ?? b.limitHomeMinor }));
}
