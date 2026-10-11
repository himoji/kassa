import { describe, it, expect } from "vitest";

import { formatMoney } from "@kassa/shared";

import { computePace } from "../../src/modules/budget/pace.ts";
import { crossedThresholds, renderEn } from "../../src/modules/budget/messages.ts";

const base = {
  limitHomeMinor: 6000000,
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  today: "2026-10-10",
};

describe("computePace", () => {
  it("3,000,000 spent of 6,000,000 on day 10 runs out on 2026-10-20 and is ahead of pace", () => {
    const p = computePace({ ...base, spentHomeMinor: 3000000 });
    expect(p.usedPct).toBe(50);
    expect(p.leftPct).toBe(50);
    expect(p.daysElapsed).toBe(10);
    expect(p.daysLeft).toBe(22);
    expect(p.remainingHomeMinor).toBe(3000000);
    expect(p.projectedRunOutDate).toBe("2026-10-20");
    expect(p.pace).toBe("AHEAD_OF_PACE");
  });

  it("1,000,000 spent projects a run-out after period end and is on track", () => {
    const p = computePace({ ...base, spentHomeMinor: 1000000 });
    expect(p.projectedRunOutDate).toBe("2026-11-29");
    expect(p.pace).toBe("ON_TRACK");
  });

  it("spending at or above the limit is OVER", () => {
    expect(computePace({ ...base, spentHomeMinor: 6000000 }).pace).toBe("OVER");
    expect(computePace({ ...base, spentHomeMinor: 6500000 }).pace).toBe("OVER");
  });

  it("zero spend has no projected run-out date and is on track", () => {
    const p = computePace({ ...base, spentHomeMinor: 0 });
    expect(p.projectedRunOutDate).toBeNull();
    expect(p.pace).toBe("ON_TRACK");
  });
});

describe("messages renderEn", () => {
  it("budget.each follows the spec §13 template", () => {
    const amount = formatMoney(476000, "HUF", "en");
    const r = renderEn({
      key: "budget.each",
      params: {
        amount: { amountMinor: 476000, currency: "HUF" },
        merchant: "Market Hall in Budapest",
        category: "groceries",
        usedPct: 62,
        leftPct: 38,
        days: 5,
        pace: "ON_TRACK",
      },
    });
    expect(amount).toContain("4,760.00");
    expect(r.body).toBe(`${amount} at Market Hall in Budapest. Groceries: 62% used, 38% left for 5 days, on track.`);
  });

  it("AHEAD_OF_PACE renders as 'ahead of pace'", () => {
    const r = renderEn({
      key: "budget.each",
      params: {
        amount: { amountMinor: 100, currency: "EUR" },
        merchant: "Shop",
        category: "shopping",
        usedPct: 70,
        leftPct: 30,
        days: 3,
        pace: "AHEAD_OF_PACE",
      },
    });
    expect(r.body).toContain("ahead of pace");
  });
});

describe("crossedThresholds", () => {
  it("returns only thresholds newly reached", () => {
    expect(crossedThresholds(45, 55)).toEqual([50]);
    expect(crossedThresholds(45, 100)).toEqual([50, 80, 100]);
    expect(crossedThresholds(50, 60)).toEqual([]);
    expect(crossedThresholds(79, 80)).toEqual([80]);
  });
});
