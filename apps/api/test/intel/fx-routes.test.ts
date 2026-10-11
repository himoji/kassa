import { describe, it, expect } from "vitest";

import { loadRails, parseRailsJson } from "../../src/modules/fx/rails.ts";
import { getRoutes, type RouteRequest } from "../../src/modules/fx/routes.ts";
import { RatesService } from "../../src/modules/fx/rates.ts";
import { applyBps } from "../../src/modules/fx/rational.ts";

const svc = new RatesService({ offline: true });

describe("rails loading", () => {
  it("loadRails reads the 11 fixture routes", () => {
    const { rails, fromFixture } = loadRails();
    expect(fromFixture).toBe(true);
    expect(rails).toHaveLength(11);
    expect(rails.map((r) => r.id)).toContain("kzt-mock-bank");
    // D-CN3: CNY funding for a Chinese student (mock bank, home bank, CNY debit card).
    expect(rails.map((r) => r.id)).toEqual(expect.arrayContaining(["cny-mock-bank", "cny-home-bank", "cny-card"]));
  });

  it("parseRailsJson returns null for an empty array", () => {
    expect(parseRailsJson([])).toBeNull();
  });

  it("parseRailsJson maps a fixture-shaped route to a RailProfile", () => {
    const rails = parseRailsJson({
      routes: [
        {
          routeId: "r",
          label: "L",
          fundingCurrency: "EUR",
          rail: "BANK_TRANSFER",
          feeFixedMinor: 0,
          feeCurrency: "EUR",
          markupBps: 10,
          settlementDays: 1,
        },
      ],
    });
    expect(rails).toHaveLength(1);
    expect(rails![0]!.id).toBe("r");
    expect(rails![0]!.fundingCurrencies).toEqual(["EUR"]);
  });
});

/** Tuition example: 2400.00 EUR bill, due 2026-10-31, today 2026-10-27. */
const tuition = (kztMinor: number): RouteRequest => ({
  amountMinor: 240000,
  toCurrency: "EUR",
  homeCurrency: "KZT",
  today: "2026-10-27",
  dueDate: "2026-10-31",
  balances: [
    { currency: "KZT", amountMinor: kztMinor },
    { currency: "USD", amountMinor: 45000 },
    { currency: "EUR", amountMinor: 30000 },
  ],
});

describe("getRoutes tuition example", () => {
  it("with the spec's literal balances (KZT 900,000 = 90000000 minor) no route is feasible", async () => {
    // 2400 EUR x 612.40 = 1,469,760 KZT, which exceeds 900,000 KZT, so every KZT route fails the balance cap.
    // The spec's expectation that kzt-mock-bank ranks first cannot hold with these balances (see the report).
    const routes = await getRoutes(tuition(90000000), svc);
    expect(routes).toEqual([]);
  });

  it("with KZT 9,000,000 (900000000 minor) the ranking is valid and bounded", async () => {
    const routes = await getRoutes(tuition(900000000), svc);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < routes.length; i++) {
      expect(routes[i - 1]!.costHomeMinor).toBeLessThanOrEqual(routes[i]!.costHomeMinor);
    }
    expect(routes.some((r) => r.fundingCurrency === "EUR")).toBe(false);
    expect(routes.some((r) => r.fundingCurrency === "USD")).toBe(false);
    for (const r of routes) expect(r.arrivalDate <= "2026-10-31").toBe(true);
    // Savings are measured against the worst feasible candidate, which is at least the worst top-3 route.
    const best = routes[0]!;
    for (const r of routes) expect(best.savingsVsWorstHomeMinor).toBeGreaterThanOrEqual(r.savingsVsWorstHomeMinor);
  });

  it("kzt-mock-bank cost is 99000 + applyBps(146976000, 55) and it ranks first", async () => {
    const amountInKzt = 146976000; // 240000 EUR-minor x 612.40, both exponents 2
    const expectedCost = 99000 + applyBps(amountInKzt, 55); // 99000 + 808368 = 907368
    expect(applyBps(amountInKzt, 55)).toBe(808368);
    expect(expectedCost).toBe(907368);

    const routes = await getRoutes(tuition(900000000), svc);
    const mock = routes.find((r) => r.routeId === "kzt-mock-bank:KZT");
    expect(mock).toBeDefined();
    expect(mock!.costHomeMinor).toBe(expectedCost);
    expect(routes[0]!.routeId).toBe("kzt-mock-bank:KZT");
  });

  it("due date equal to today keeps only settlementDays 0 rails", async () => {
    const routes = await getRoutes({ ...tuition(900000000), dueDate: "2026-10-27" }, svc);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r.arrivalDate).toBe("2026-10-27");
  });
});

describe("getRoutes same currency and empty balances", () => {
  it("bill in HUF funded from HUF has no markup and zero cost for the HUF bank route", async () => {
    const routes = await getRoutes(
      {
        amountMinor: 10000,
        toCurrency: "HUF",
        homeCurrency: "KZT",
        today: "2026-10-27",
        balances: [{ currency: "HUF", amountMinor: 1000000 }],
      },
      svc,
    );
    const bank = routes.find((r) => r.routeId === "huf-mock-bank:HUF");
    expect(bank).toBeDefined();
    expect(bank!.markupBps).toBe(0);
    expect(bank!.costHomeMinor).toBe(0);
  });

  it("empty balances give no routes", async () => {
    const routes = await getRoutes({ ...tuition(900000000), balances: [] }, svc);
    expect(routes).toEqual([]);
  });
});
