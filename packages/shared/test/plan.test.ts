import { describe, expect, it } from "vitest";

import { monthlyIncomeOf, planOutcome, trimBudgetsForGoal, withBudgetChanges } from "../src/plan.ts";

// The user's example: $1,400 salary, some spending, save $3,700 in 6 months (USD minor units).
const base = {
  monthlyIncomeMinor: 140_000,
  fixedMonthlyMinor: 50_000, // rent
  budgets: [
    { category: "groceries", limitHomeMinor: 20_000 },
    { category: "eating_out", limitHomeMinor: 15_000 },
    { category: "transport", limitHomeMinor: 5_000 },
    { category: "utilities", limitHomeMinor: 6_000 },
  ],
  goal: { amountMinor: 370_000, months: 6 },
};

describe("plan", () => {
  it("monthly income per cadence", () => {
    expect(monthlyIncomeOf(10_000, "WEEKLY")).toBe(43_333);
    expect(monthlyIncomeOf(140_000, "MONTHLY")).toBe(140_000);
    expect(monthlyIncomeOf(60_000, "TERM")).toBe(10_000);
    expect(monthlyIncomeOf(60_000, "ONCE")).toBe(0);
  });

  it("left each month, six-month projection and months to the goal", () => {
    const o = planOutcome(base);
    expect(o.budgetsTotalMinor).toBe(46_000);
    expect(o.monthlyLeftMinor).toBe(44_000);
    expect(o.projectedMinor).toBe(264_000);
    expect(o.neededPerMonthMinor).toBe(61_667);
    expect(o.monthsToGoal).toBe(9);
    expect(o.goalReached).toBe(false);
  });

  it("trims only flexible budgets, by at most half, and closes the gap when it can", () => {
    const changes = trimBudgetsForGoal(base);
    expect(changes.map((c) => c.category).sort()).toEqual(["eating_out", "groceries", "transport"]);
    for (const c of changes) {
      const before = base.budgets.find((b) => b.category === c.category)!.limitHomeMinor;
      expect(c.limitHomeMinor).toBeLessThan(before);
      expect(c.limitHomeMinor).toBeGreaterThanOrEqual(before / 2);
    }
    const after = planOutcome({ ...base, budgets: withBudgetChanges(base.budgets, changes) });
    expect(after.goalReached).toBe(true);
  });

  it("no change when the goal already fits; a negative month projects to 0", () => {
    expect(trimBudgetsForGoal({ ...base, goal: { amountMinor: 100_000, months: 6 } })).toEqual([]);
    const broke = planOutcome({ ...base, monthlyIncomeMinor: 60_000 });
    expect(broke.monthlyLeftMinor).toBeLessThan(0);
    expect(broke.projectedMinor).toBe(0);
    expect(broke.monthsToGoal).toBeNull();
  });

  it("projects over the chosen months before a goal is set", () => {
    const o = planOutcome({ monthlyIncomeMinor: 140_000, fixedMonthlyMinor: 60_000, budgets: [{ category: "groceries", limitHomeMinor: 30_000 }], goal: null, months: 6 });
    expect(o.monthlyLeftMinor).toBe(50_000);
    expect(o.projectedMinor).toBe(300_000);
    expect(o.goalReached).toBe(false);
  });
});
