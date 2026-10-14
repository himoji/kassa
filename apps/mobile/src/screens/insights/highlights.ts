import type { SpendingInsightsResponse } from "@kassa/shared";

/*
 * "Worth knowing" lines for the insights screen, picked from the server's numbers (no money is computed here
 * beyond the difference of two server amounts). Most urgent first, at most MAX_HIGHLIGHTS.
 */

export const MAX_HIGHLIGHTS = 3;
/** A category this big a share of the month is worth a line (only once the month has a few purchases). */
const BIG_SHARE_PCT = 40;
const BIG_SHARE_MIN_COUNT = 5;

export type Highlight =
  | { kind: "overBudget"; category: string; amountMinor: number }
  | { kind: "fastBudget"; category: string; amountMinor: number; days: number }
  | { kind: "aboveUsual"; category: string; amountMinor: number }
  | { kind: "bigShare"; category: string; pct: number }
  | { kind: "projectedOverIncome" }
  | { kind: "quietMonth" };

export function insightHighlights(data: SpendingInsightsResponse): Highlight[] {
  const out: Highlight[] = [];
  for (const c of data.categories) {
    if (c.budget && c.budget.remainingMinor < 0) {
      out.push({ kind: "overBudget", category: c.category, amountMinor: -c.budget.remainingMinor });
    }
  }
  for (const c of data.categories) {
    if (c.budget && c.budget.remainingMinor >= 0 && c.budget.pace === "AHEAD_OF_PACE") {
      out.push({
        kind: "fastBudget",
        category: c.category,
        amountMinor: c.budget.remainingMinor,
        days: c.budget.daysLeft,
      });
    }
  }
  if (
    data.monthlyIncomeMinor !== null &&
    data.month.daysElapsed >= 7 &&
    data.projectedMinor > data.monthlyIncomeMinor
  ) {
    out.push({ kind: "projectedOverIncome" });
  }
  for (const c of data.categories) {
    if (!c.budget && c.typicalMinor !== null && c.spentMinor > c.typicalMinor) {
      out.push({
        kind: "aboveUsual",
        category: c.category,
        amountMinor: c.spentMinor - c.typicalMinor,
      });
    }
  }
  const top = data.categories[0];
  if (top && data.count >= BIG_SHARE_MIN_COUNT && top.sharePct >= BIG_SHARE_PCT) {
    out.push({ kind: "bigShare", category: top.category, pct: top.sharePct });
  }
  if (
    out.length === 0 &&
    data.lastMonthToDateMinor !== null &&
    data.totalMinor > 0 &&
    data.typicalMonthMinor !== null &&
    data.projectedMinor < data.typicalMonthMinor
  ) {
    out.push({ kind: "quietMonth" });
  }
  return out.slice(0, MAX_HIGHLIGHTS);
}
