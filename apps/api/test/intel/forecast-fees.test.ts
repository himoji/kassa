import { describe, it, expect } from "vitest";

import { bestCard, dccFlag, rollingMedianBps, settlementFee, type CardFeeProfile } from "../../src/modules/fx/fees.ts";
import {
  addMonths,
  burnRate,
  computeForecast,
  medianInt,
  occurrences,
  projectBalances,
  type ForecastInput,
} from "../../src/modules/fx/forecast.ts";
import { RatesService } from "../../src/modules/fx/rates.ts";
import { parseDecimal } from "../../src/modules/fx/rational.ts";

const svc = new RatesService({ offline: true });

describe("forecast helpers", () => {
  it("addMonths clamps to the end of a shorter month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("MONTHLY occurrences fall inside the requested range", () => {
    const out = occurrences(
      { currency: "KZT", amountMinor: 1, date: "2026-10-25", cadence: "MONTHLY" },
      "2026-10-01",
      "2026-12-31",
    );
    expect(out).toEqual(["2026-10-25", "2026-11-25", "2026-12-25"]);
  });

  it("a ONCE flow before the range produces no occurrences", () => {
    expect(
      occurrences({ currency: "KZT", amountMinor: 1, date: "2026-09-01", cadence: "ONCE" }, "2026-10-01", "2026-12-31"),
    ).toEqual([]);
  });

  it("medianInt rounds the middle pair half-up and handles empty input", () => {
    expect(medianInt([1, 2, 3, 4])).toBe(3);
    expect(medianInt([])).toBe(0);
  });

  it("burnRate is the median daily spend over 30 days, zero days included", () => {
    const today = "2026-10-27";
    // 16 distinct days inside the last 30 days, 1000 each; the other 14 days are zero.
    const spends = Array.from({ length: 16 }, (_, i) => ({
      currency: "KZT",
      amountMinor: 1000,
      date: addDaysIso(today, -(i + 1)),
    }));
    expect(burnRate(spends, "KZT", today)).toBe(1000);
  });

  it("burnRate is zero when spending is on only 10 of 30 days", () => {
    const today = "2026-10-27";
    const spends = Array.from({ length: 10 }, (_, i) => ({
      currency: "KZT",
      amountMinor: 1000,
      date: addDaysIso(today, -(i + 1)),
    }));
    expect(burnRate(spends, "KZT", today)).toBe(0);
  });
});

describe("projectBalances", () => {
  const input: ForecastInput = {
    today: "2026-10-27",
    homeCurrency: "KZT",
    balances: [{ currency: "EUR", amountMinor: 30000 }],
    incomes: [],
    obligations: [{ currency: "EUR", amountMinor: 240000, date: "2026-10-31", cadence: "ONCE" }],
    spends: [],
    reserves: { EUR: 0 },
  };

  it("projects 46 daily points and a shortfall on the due date", () => {
    const [eur] = projectBalances(input);
    expect(eur!.currency).toBe("EUR");
    expect(eur!.points).toHaveLength(46);
    expect(eur!.points.find((p) => p.date === "2026-10-30")?.balanceMinor).toBe(30000);
    expect(eur!.shortfall).toEqual({ date: "2026-10-31", amountMinor: 210000 });
  });
});

describe("computeForecast", () => {
  it("suggests converting KZT surplus into the EUR shortfall via the route optimizer", async () => {
    const res = await computeForecast(
      {
        today: "2026-10-27",
        homeCurrency: "KZT",
        balances: [
          { currency: "EUR", amountMinor: 30000 },
          { currency: "KZT", amountMinor: 900000000 },
        ],
        incomes: [],
        obligations: [{ currency: "EUR", amountMinor: 240000, date: "2026-10-31", cadence: "ONCE" }],
        spends: [],
      },
      svc,
    );
    expect(res.suggestions).toHaveLength(1);
    const s = res.suggestions[0]!;
    expect(s.fromCurrency).toBe("KZT");
    expect(s.toCurrency).toBe("EUR");
    expect(s.amountMinor).toBe(210000);
    expect(s.byDate).toBe("2026-10-31");
    expect(s.route).not.toBeNull();
    expect(s.route!.arrivalDate <= "2026-10-31").toBe(true);
  });
});

describe("settlementFee", () => {
  it("computes the home-currency fee and markup from mid-market", () => {
    const r = settlementFee({
      amountOriginalMinor: 476000,
      originalCurrency: "HUF",
      settledAmountMinor: 761600,
      settledCurrency: "KZT",
      homeCurrency: "KZT",
      midOrigToHome: parseDecimal("1.56"),
    });
    expect(r.midHomeMinor).toBe(742560);
    expect(r.settledHomeMinor).toBe(761600);
    expect(r.feeHomeMinor).toBe(19040);
    expect(r.markupBps).toBe(256);
  });

  it("requires midSettledToHome when the settled currency differs from home", () => {
    expect(() =>
      settlementFee({
        amountOriginalMinor: 476000,
        originalCurrency: "HUF",
        settledAmountMinor: 1200,
        settledCurrency: "USD",
        homeCurrency: "KZT",
        midOrigToHome: parseDecimal("1.56"),
      }),
    ).toThrow(RangeError);
  });
});

describe("rollingMedianBps", () => {
  it("takes the median of a short series", () => {
    expect(rollingMedianBps([10, 20, 30])).toBe(20);
  });

  it("only uses the last 20 samples", () => {
    // Oldest five are 0; the last 20 are 1..20 (median 10.5, rounds to 11).
    // All 25 samples would give median 8, so the window must be what is applied.
    const samples = [0, 0, 0, 0, 0, ...Array.from({ length: 20 }, (_, i) => i + 1)];
    expect(rollingMedianBps(samples)).toBe(11);
  });
});

describe("bestCard", () => {
  const profiles: CardFeeProfile[] = [
    { cardId: "a", fromCurrency: "HUF", toCurrency: "KZT", medianMarkupBps: 400, fixedFeeMinor: 0 },
    { cardId: "b", fromCurrency: "HUF", toCurrency: "USD", medianMarkupBps: 250, fixedFeeMinor: 0 },
  ];
  const cards = [
    { id: "a", billingCurrency: "KZT" },
    { id: "b", billingCurrency: "USD" },
    { id: "c", billingCurrency: "HUF" },
  ];

  it("prefers the card billed in the spend currency (zero markup)", () => {
    expect(bestCard(10000, "HUF", profiles, cards)).toEqual({ cardId: "c", costHomeMinor: 0 });
  });

  it("without card c the lowest-markup card wins", () => {
    expect(bestCard(10000, "HUF", profiles, cards.slice(0, 2))).toEqual({ cardId: "b", costHomeMinor: 250 });
  });

  it("a card with no profile for the pair is skipped", () => {
    expect(bestCard(10000, "HUF", profiles, [{ id: "d", billingCurrency: "EUR" }])).toBeNull();
  });
});

describe("dccFlag", () => {
  it("flags a charge more than 2% over mid and reports the bps", () => {
    expect(
      dccFlag({
        chargedHomeMinor: 1050000,
        localAmountMinor: 600000,
        localCurrency: "HUF",
        homeCurrency: "KZT",
        midLocalToHome: parseDecimal("1.70"),
      }),
    ).toEqual({ overMidBps: 294 });
  });

  it("does not flag a charge within 2% of mid", () => {
    expect(
      dccFlag({
        chargedHomeMinor: 1030000,
        localAmountMinor: 600000,
        localCurrency: "HUF",
        homeCurrency: "KZT",
        midLocalToHome: parseDecimal("1.70"),
      }),
    ).toBeNull();
  });

  it("returns null when the local currency is the home currency", () => {
    expect(
      dccFlag({
        chargedHomeMinor: 1050000,
        localAmountMinor: 1050000,
        localCurrency: "KZT",
        homeCurrency: "KZT",
        midLocalToHome: parseDecimal("1"),
      }),
    ).toBeNull();
  });
});

/** Shift an ISO date by whole days (UTC), for building spend fixtures. */
function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
