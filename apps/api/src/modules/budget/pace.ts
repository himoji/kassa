import type { BudgetPace } from "@kassa/shared";

import { addDays, daysBetween } from "../fx/dates.ts";

/*
 * Budget pace (spec §13): projected run-out date = remaining ÷ (spent ÷ daysElapsed), integer maths.
 * Days are calendar days in the budget period, inclusive of today ("left for {days} days" counts today).
 */

export interface PaceInput {
  limitHomeMinor: number;
  spentHomeMinor: number;
  periodStart: string;
  periodEnd: string;
  today: string;
}

export interface PaceResult {
  spentHomeMinor: number;
  remainingHomeMinor: number;
  usedPct: number;
  leftPct: number;
  daysElapsed: number;
  daysLeft: number;
  projectedRunOutDate: string | null;
  pace: BudgetPace;
}

export function computePace(i: PaceInput): PaceResult {
  const totalDays = daysBetween(i.periodStart, i.periodEnd) + 1;
  const daysElapsed = Math.min(totalDays, Math.max(1, daysBetween(i.periodStart, i.today) + 1));
  const daysLeft = Math.max(0, daysBetween(i.today, i.periodEnd) + 1);
  const remaining = i.limitHomeMinor - i.spentHomeMinor;
  const usedPct = i.limitHomeMinor > 0 ? Math.floor((i.spentHomeMinor * 100) / i.limitHomeMinor) : 100;
  const leftPct = Math.max(0, 100 - usedPct);
  let projectedRunOutDate: string | null = null;
  if (i.spentHomeMinor > 0 && remaining > 0) {
    // days until empty = remaining / (spent / daysElapsed) = remaining·daysElapsed / spent
    const daysToEmpty = Math.floor((remaining * daysElapsed) / i.spentHomeMinor);
    projectedRunOutDate = addDays(i.today, daysToEmpty);
  } else if (remaining <= 0) projectedRunOutDate = i.today;
  const pace: BudgetPace = remaining <= 0 ? "OVER" : projectedRunOutDate !== null && projectedRunOutDate < i.periodEnd ? "AHEAD_OF_PACE" : "ON_TRACK";
  return {
    spentHomeMinor: i.spentHomeMinor,
    remainingHomeMinor: remaining,
    usedPct,
    leftPct,
    daysElapsed,
    daysLeft,
    projectedRunOutDate,
    pace,
  };
}
