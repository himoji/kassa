import { isSupportedCurrency, withGenericMockBankRoutes } from "@kassa/shared";

import fxFixture from "../../../../fixtures/fx-rates.json" with { type: "json" };
import railsFixture from "../../../../fixtures/rails.json" with { type: "json" };
import type { FetchLike } from "../clock.ts";

/*
 * Mid-market rates for mock bank quotes (spec §11: "rates come from the API's fx service plus a
 * per-rail markup in fixtures/rails.json"). Tries GET {API_URL}/api/fx/rates; falls back to the labelled example table in
 * fixtures/fx-rates.json. Rates are decimal strings quoted against one base, ECB style.
 */

export interface RateTable {
  base: string;
  date: string;
  rates: Record<string, string>;
  source: "API_FX" | "FIXTURE_EXAMPLE";
}

export interface RateProvider {
  getRates(): Promise<RateTable>;
}

export interface RailRoute {
  routeId: string;
  label: string;
  fundingCurrency: string;
  rail: string;
  provider: "MOCK_BANK" | "HOME_BANK" | "CARD";
  cardKind: string | null;
  feeFixedMinor: number;
  feeCurrency: string;
  markupBps: number;
  settlementDays: number;
}

/** The fixture's routes plus the generic mock bank transfer for every other wallet currency. */
export const RAIL_ROUTES = withGenericMockBankRoutes(railsFixture.routes as RailRoute[]) as RailRoute[];

export const FIXTURE_RATES: RateTable = {
  base: fxFixture.base,
  date: fxFixture.date,
  rates: fxFixture.rates as Record<string, string>,
  source: "FIXTURE_EXAMPLE",
};

export class StaticRates implements RateProvider {
  constructor(private readonly table: RateTable = FIXTURE_RATES) {}
  async getRates(): Promise<RateTable> {
    return this.table;
  }
}

const DECIMAL = /^\d+(\.\d+)?$/;

function validTable(body: unknown): body is { base: string; date: string; rates: Record<string, string> } {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.base !== "string" || typeof b.date !== "string" || !b.rates || typeof b.rates !== "object") return false;
  const rates = b.rates as Record<string, unknown>;
  // Every currency the mock bank can quote must be present and a plain positive decimal string.
  for (const c of Object.keys(FIXTURE_RATES.rates)) {
    const v = rates[c];
    if (typeof v !== "string" || !DECIMAL.test(v) || /^0+(\.0+)?$/.test(v)) return false;
  }
  return isSupportedCurrency(b.base);
}

export class ApiRates implements RateProvider {
  private cache: { at: number; table: RateTable } | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly opts: { fetch?: FetchLike; ttlMs?: number; timeoutMs?: number; realNow?: () => number } = {},
  ) {}

  async getRates(): Promise<RateTable> {
    const now = (this.opts.realNow ?? Date.now)();
    if (this.cache && now - this.cache.at < (this.opts.ttlMs ?? 10 * 60_000)) return this.cache.table;
    let table: RateTable = FIXTURE_RATES;
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.apiUrl}/api/fx/rates?base=EUR`, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 1500),
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (validTable(body)) table = { base: body.base, date: body.date, rates: body.rates, source: "API_FX" };
      }
    } catch {
      // Fall back to the example table; quotes carry rateSource so the UI can label it.
    }
    // Cache fallbacks briefly so a recovering API is picked up soon.
    this.cache = { at: table.source === "API_FX" ? now : now - (this.opts.ttlMs ?? 10 * 60_000) + 30_000, table };
    return table;
  }
}

/** The mock bank's own route for a funding currency (provider MOCK_BANK in rails.json). */
export function mockBankRoute(fundingCurrency: string, routeId?: string): RailRoute | undefined {
  return RAIL_ROUTES.find(
    (r) => r.provider === "MOCK_BANK" && r.fundingCurrency === fundingCurrency && (routeId === undefined || r.routeId === routeId),
  );
}
