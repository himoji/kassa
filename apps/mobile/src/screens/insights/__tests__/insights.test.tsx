import { describe, expect, it } from "@jest/globals";
import type { SpendingInsightsResponse } from "@kassa/shared";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";

import { insightHighlights } from "../highlights";
import { InsightsBody } from "../insights-screen";

const BASE: SpendingInsightsResponse = {
  homeCurrency: "HUF",
  month: { start: "2026-10-01", end: "2026-10-31", daysTotal: 31, daysElapsed: 3, daysLeft: 29 },
  totalMinor: 1_100_000,
  count: 6,
  lastMonthToDateMinor: 600_000,
  lastMonthTotalMinor: 2_600_000,
  typicalMonthMinor: 2_800_000,
  projectedMinor: 11_366_667,
  monthlyIncomeMinor: 20_000_000,
  incomeUsedPct: 5,
  outsideBudgetsMinor: 500_000,
  daily: [
    { date: "2026-10-01", spentMinor: 0 },
    { date: "2026-10-02", spentMinor: 600_000 },
    { date: "2026-10-03", spentMinor: 500_000 },
  ],
  categories: [
    {
      category: "groceries",
      spentMinor: 600_000,
      count: 4,
      typicalMinor: 1_800_000,
      sharePct: 54,
      budget: {
        limitMinor: 500_000,
        spentMinor: 600_000,
        remainingMinor: -100_000,
        daysLeft: 29,
        pace: "OVER",
      },
    },
    {
      category: "eating_out",
      spentMinor: 500_000,
      count: 2,
      typicalMinor: 200_000,
      sharePct: 45,
      budget: null,
    },
  ],
  topMerchants: [{ name: "Spar", spentMinor: 600_000, count: 4 }],
};

describe("insightHighlights", () => {
  it("puts an overspent budget first, then spending above a usual month and a big share", () => {
    expect(insightHighlights(BASE)).toEqual([
      { kind: "overBudget", category: "groceries", amountMinor: 100_000 },
      { kind: "aboveUsual", category: "eating_out", amountMinor: 300_000 },
      { kind: "bigShare", category: "groceries", pct: 54 },
    ]);
  });

  it("calls a month below the usual pace quiet when nothing else stands out", () => {
    const calm: SpendingInsightsResponse = {
      ...BASE,
      count: 2,
      projectedMinor: 1_000_000,
      categories: [{ ...BASE.categories[1]!, typicalMinor: 900_000 }],
    };
    expect(insightHighlights(calm)).toEqual([{ kind: "quietMonth" }]);
  });

  it("warns when the pace ends the month above income (after the first week)", () => {
    const fast: SpendingInsightsResponse = {
      ...BASE,
      month: { ...BASE.month, daysElapsed: 10 },
      projectedMinor: 25_000_000,
      categories: [],
    };
    expect(insightHighlights(fast)).toEqual([{ kind: "projectedOverIncome" }]);
  });
});

describe("InsightsBody", () => {
  it("shows the month, the comparison, the highlights, categories and merchants", async () => {
    await render(
      <ThemeProvider>
        <InsightsBody data={BASE} />
      </ThemeProvider>
    );
    expect(screen.getByTestId("month-total")).toBeTruthy();
    expect(screen.getByText(/more than this point last month/)).toBeTruthy();
    expect(screen.getByText(/Groceries is over budget by/)).toBeTruthy();
    expect(screen.getByText("Groceries")).toBeTruthy();
    expect(screen.getByText("Spar")).toBeTruthy();
    // Tapping a day names it above the chart.
    await fireEvent.press(screen.getByLabelText(/Oct 3/));
    expect(screen.getByTestId("daily-caption").props.children).toMatch(/^Oct 3: /);
  });
});
