/*
 * Y4: (p1 B2, cn D-CN3) the forecast's top-up suggestion is sized to the FIRST shortfall (deficit to the reserve on
 * the shortfall date), not to the worst deficit over the whole horizon; (p1 B10) a same-currency route query returns
 * a direct "no conversion" route, even when the balance in that currency does not cover the bill.
 */
import { describe, expect, it } from "vitest";

import { computeForecast } from "../../src/modules/fx/forecast.ts";
import { directRoute } from "../../src/modules/fx/routes.ts";
import { RatesService } from "../../src/modules/fx/rates.ts";

const svc = new RatesService({ offline: true });

describe("forecast top-up sized to the first shortfall (Y4, p1 B2)", () => {
  it("rent on 11-01 then a second rent on 12-01: the suggestion covers the 11-01 shortfall plus the reserve", async () => {
    const res = await computeForecast(
      {
        today: "2026-10-27",
        homeCurrency: "KZT",
        balances: [
          { currency: "HUF", amountMinor: 12000000 },
          { currency: "KZT", amountMinor: 9000000000 },
        ],
        incomes: [],
        obligations: [{ currency: "HUF", amountMinor: 18000000, date: "2026-11-01", cadence: "MONTHLY" }],
        spends: [],
        reserves: { HUF: 1000000 },
      },
      svc,
    );
    const huf = res.currencies.find((c) => c.currency === "HUF")!;
    // First shortfall: 120,000 − 180,000 = −60,000 → 70,000 below the 10,000 reserve.
    expect(huf.shortfall).toEqual({ date: "2026-11-01", amountMinor: 7000000 });
    const s = res.suggestions.find((x) => x.toCurrency === "HUF")!;
    expect(s.byDate).toBe("2026-11-01");
    // Not the horizon-end deficit (two rents: 250,000).
    expect(s.amountMinor).toBe(7000000);
  });

  it("a single shortfall is unchanged (amount = deficit to reserve on that date)", async () => {
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
    expect(res.suggestions[0]!.amountMinor).toBe(210000);
  });
});

describe("same-currency routes (Y4, p1 B10)", () => {
  it("EUR → EUR returns a direct route with no conversion even when the EUR balance is short", async () => {
    const r = await directRoute({ amountMinor: 240000, toCurrency: "EUR", homeCurrency: "KZT", today: "2026-10-27", dueDate: "2026-10-31", balances: [{ currency: "EUR", amountMinor: 30000 }] }, svc);
    expect(r).not.toBeNull();
    expect(r!.fundingCurrency).toBe("EUR");
    expect(r!.markupBps).toBe(0);
    expect(r!.noConversion).toBe(true);
    expect(r!.balanceCovers).toBe(false);
    expect(r!.arrivalDate <= "2026-10-31").toBe(true);
  });

  it("covered: balanceCovers true", async () => {
    const r = await directRoute({ amountMinor: 10000, toCurrency: "EUR", homeCurrency: "KZT", today: "2026-10-27", balances: [{ currency: "EUR", amountMinor: 30000 }] }, svc);
    expect(r!.balanceCovers).toBe(true);
    expect(r!.noConversion).toBe(true);
  });
});
