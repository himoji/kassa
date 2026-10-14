/* POST /plan/advice (the "your rules" planner): numbers from shared/plan.ts, the rule's trims when the goal does not fit. */
import { beforeEach, describe, expect, it } from "vitest";

import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const body = {
  currency: "USD",
  monthlyIncomeMinor: 140_000,
  fixedMonthlyMinor: 50_000,
  budgets: [
    { category: "groceries", limitHomeMinor: 20_000 },
    { category: "eating_out", limitHomeMinor: 15_000 },
    { category: "utilities", limitHomeMinor: 6_000 },
  ],
  goal: { amountMinor: 370_000, months: 6 },
};

describe("POST /plan/advice", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("trims flexible budgets so a $3,700 / 6 months goal fits on $1,400 a month", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/plan/advice", headers: await bearer(userId), payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json();
    expect(a.source).toBe("RULES"); // no AI consent → the deterministic rule
    expect(a.budgets.map((b: { category: string }) => b.category).sort()).toEqual(["eating_out", "groceries"]);
    expect(a.projectedMinor).toBeGreaterThanOrEqual(370_000);
    expect(a.summary).toMatch(/Trim/);
  });

  it("no trims when the goal already fits", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/plan/advice", headers: await bearer(userId), payload: { ...body, goal: { amountMinor: 100_000, months: 6 } } });
    expect(res.json()).toMatchObject({ budgets: [], monthlyLeftMinor: 49_000, projectedMinor: 294_000, monthsToGoal: 3 });
    expect(res.json().summary).toMatch(/on track/);
  });
});
