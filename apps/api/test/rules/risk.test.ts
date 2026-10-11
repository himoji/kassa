import { describe, expect, it } from "vitest";

import { median, riskFeatures, riskScore, type RiskInputs } from "../../src/modules/rules/risk.ts";
import { RISK_WEIGHTS, type RiskFeatures } from "../../src/modules/rules/riskWeights.ts";

function zeros(): RiskFeatures {
  return {
    newMerchant: 0,
    priceAboveMedian: 0,
    budgetShare: 0,
    quantityVsHistory: 0,
    unusualHour: 0,
    triggerOrigin: 0,
    readerUnverifiedNonCritical: 0,
  };
}

function inputs(over: Partial<RiskInputs> = {}): RiskInputs {
  return {
    priorPaymentsToPayee: 3,
    items: [],
    priceHistory: {},
    qtyHistory: {},
    amountHomeMinor: 0,
    categoryRemainingHomeMinor: null,
    localHour: 12,
    triggerOrigin: false,
    readerUnverifiedNonCritical: false,
    ...over,
  };
}

describe("median", () => {
  it("returns null for an empty list", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("RISK_WEIGHTS", () => {
  it("sum to 1", () => {
    const sum = Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("riskFeatures", () => {
  it("newMerchant is 1 when there are no prior payments to the payee, else 0", () => {
    expect(riskFeatures(inputs({ priorPaymentsToPayee: 0 })).newMerchant).toBe(1);
    expect(riskFeatures(inputs({ priorPaymentsToPayee: 2 })).newMerchant).toBe(0);
  });

  it("priceAboveMedian scales the unit price against the historical median and clamps to [0,1]", () => {
    const history = { priceHistory: { a: [100, 100, 100] } };
    const price = (unitPriceMinor: number) =>
      riskFeatures(inputs({ ...history, items: [{ key: "a", unitPriceMinor, quantity: 1 }] })).priceAboveMedian;
    expect(price(125)).toBeCloseTo(0.5, 10);
    expect(price(150)).toBeCloseTo(1, 10);
    expect(price(200)).toBe(1);
    expect(price(90)).toBe(0);
  });

  it("quantityVsHistory is the relative deviation from the median quantity, clamped", () => {
    const qty = (quantity: number) =>
      riskFeatures(inputs({ qtyHistory: { a: [2, 2, 2] }, items: [{ key: "a", unitPriceMinor: 1, quantity }] })).quantityVsHistory;
    expect(qty(3)).toBeCloseTo(0.5, 10);
    expect(qty(20)).toBe(1);
  });

  it("budgetShare is amount over remaining budget, 1 when nothing remains, 0 when no budget", () => {
    const share = (amountHomeMinor: number, categoryRemainingHomeMinor: number | null) =>
      riskFeatures(inputs({ amountHomeMinor, categoryRemainingHomeMinor })).budgetShare;
    expect(share(500, 1000)).toBeCloseTo(0.5, 10);
    expect(share(500, 0)).toBe(1);
    expect(share(500, null)).toBe(0);
  });

  it("unusualHour is 1 between 00:00 and 05:59 and 0 otherwise", () => {
    expect(riskFeatures(inputs({ localHour: 3 })).unusualHour).toBe(1);
    expect(riskFeatures(inputs({ localHour: 6 })).unusualHour).toBe(0);
    expect(riskFeatures(inputs({ localHour: 23 })).unusualHour).toBe(0);
  });

  it("triggerOrigin and readerUnverifiedNonCritical map booleans to 1", () => {
    const f = riskFeatures(inputs({ triggerOrigin: true, readerUnverifiedNonCritical: true }));
    expect(f.triggerOrigin).toBe(1);
    expect(f.readerUnverifiedNonCritical).toBe(1);
    const g = riskFeatures(inputs());
    expect(g.triggerOrigin).toBe(0);
    expect(g.readerUnverifiedNonCritical).toBe(0);
  });
});

describe("riskScore", () => {
  it("all-ones features give 1", () => {
    const ones = Object.fromEntries(Object.keys(RISK_WEIGHTS).map((k) => [k, 1])) as RiskFeatures;
    expect(riskScore(ones)).toBe(1);
  });

  it("all-zero features give 0", () => {
    expect(riskScore(zeros())).toBe(0);
  });

  it("only newMerchant gives its weight, 0.3", () => {
    expect(riskScore({ ...zeros(), newMerchant: 1 })).toBe(0.3);
  });

  it("newMerchant plus triggerOrigin gives 0.4", () => {
    expect(riskScore({ ...zeros(), newMerchant: 1, triggerOrigin: 1 })).toBe(0.4);
  });

  it("rounds to 4 decimals so IEEE sums like 0.2 + 0.1 are exact", () => {
    // budgetShare (0.2) + triggerOrigin (0.1) = 0.30000000000000004 in floating point.
    const raw = RISK_WEIGHTS.budgetShare + RISK_WEIGHTS.triggerOrigin;
    expect(raw).not.toBe(0.3);
    expect(riskScore({ ...zeros(), budgetShare: 1, triggerOrigin: 1 })).toBe(0.3);
  });

  it("clamps out-of-range feature values to [0,1]", () => {
    expect(riskScore({ ...zeros(), newMerchant: 5 })).toBe(0.3);
    expect(riskScore({ ...zeros(), newMerchant: -5 })).toBe(0);
  });
});
