import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { Rail } from "@kassa/shared";

/*
 * Funding rails for the route optimizer (spec §12) from `fixtures/rails.json` (owned by Track D):
 * `{routes: [{routeId, label, fundingCurrency, rail, provider, cardKind, feeFixedMinor, feeCurrency,
 * markupBps, settlementDays}]}`. Also accepts a bare array / `{rails: [...]}` of `RailProfile`.
 * Tolerates absence with the labelled defaults below.
 */

export const RailProfile = z.object({
  id: z.string(),
  label: z.string(),
  rail: Rail.default("BANK_TRANSFER"),
  /** Funding currencies this rail can debit; omitted = any. */
  fundingCurrencies: z.array(z.string().length(3)).optional(),
  /** Bill currencies it can deliver; omitted = any. */
  toCurrencies: z.array(z.string().length(3)).optional(),
  feeFixedMinor: z.number().int().nonnegative(),
  feeCurrency: z.string().length(3),
  markupBps: z.number().int().nonnegative(),
  settlementDays: z.number().int().nonnegative(),
  /** Per-transfer cap in funding-currency minor units. */
  maxAmountMinor: z.number().int().positive().optional(),
  /** Who executes it (rails.json `provider`): only MOCK_BANK routes can be executed by the bank rail (B2). */
  provider: z.string().optional(),
});
export type RailProfile = z.infer<typeof RailProfile>;

/** Example values, labelled as such in the UI (spec §1 "everything mocked is labelled"). */
export const DEFAULT_RAILS: RailProfile[] = [
  { id: "wallet-convert", label: "Kassa wallet conversion (simulated)", rail: "BANK_TRANSFER", provider: "MOCK_BANK", feeFixedMinor: 0, feeCurrency: "EUR", markupBps: 45, settlementDays: 1 },
  { id: "kz-bank-swift", label: "Home bank international transfer (example)", rail: "BANK_TRANSFER", provider: "HOME_BANK", fundingCurrencies: ["KZT"], feeFixedMinor: 500000, feeCurrency: "KZT", markupBps: 150, settlementDays: 3 },
  { id: "card-kzt", label: "KZT card payment (example)", rail: "CARD_ISSUING", provider: "CARD", fundingCurrencies: ["KZT"], feeFixedMinor: 0, feeCurrency: "KZT", markupBps: 400, settlementDays: 0 },
  { id: "card-usd", label: "USD card payment (example)", rail: "CARD_ISSUING", provider: "CARD", fundingCurrencies: ["USD"], feeFixedMinor: 0, feeCurrency: "USD", markupBps: 250, settlementDays: 0 },
];

/** Track D's fixture row. */
const FixtureRoute = z.object({
  routeId: z.string(),
  label: z.string(),
  fundingCurrency: z.string().length(3),
  rail: Rail,
  feeFixedMinor: z.number().int().nonnegative(),
  feeCurrency: z.string().length(3),
  markupBps: z.number().int().nonnegative(),
  settlementDays: z.number().int().nonnegative(),
  maxAmountMinor: z.number().int().positive().optional(),
  provider: z.string().optional(),
});

function fromFixtureRoute(r: z.infer<typeof FixtureRoute>): RailProfile {
  return {
    id: r.routeId,
    label: r.label,
    rail: r.rail,
    fundingCurrencies: [r.fundingCurrency],
    feeFixedMinor: r.feeFixedMinor,
    feeCurrency: r.feeCurrency,
    markupBps: r.markupBps,
    settlementDays: r.settlementDays,
    ...(r.maxAmountMinor !== undefined ? { maxAmountMinor: r.maxAmountMinor } : {}),
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
  };
}

export function parseRailsJson(raw: unknown): RailProfile[] | null {
  const obj = raw as { routes?: unknown; rails?: unknown };
  if (obj && !Array.isArray(raw) && Array.isArray(obj.routes)) {
    const p = z.array(FixtureRoute).safeParse(obj.routes);
    return p.success && p.data.length > 0 ? p.data.map(fromFixtureRoute) : null;
  }
  const list = Array.isArray(raw) ? raw : obj?.rails;
  const p = z.array(RailProfile).safeParse(list);
  return p.success && p.data.length > 0 ? p.data : null;
}

const here = dirname(fileURLToPath(import.meta.url));
export const RAILS_FIXTURE_PATH = resolve(here, "../../../../../fixtures/rails.json");

let cache: { rails: RailProfile[]; fromFixture: boolean } | null = null;

export function loadRails(path = RAILS_FIXTURE_PATH): { rails: RailProfile[]; fromFixture: boolean } {
  if (cache && path === RAILS_FIXTURE_PATH) return cache;
  let out = { rails: DEFAULT_RAILS, fromFixture: false };
  if (existsSync(path)) {
    try {
      const parsed = parseRailsJson(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) out = { rails: parsed, fromFixture: true };
      else console.warn(`[fx] ${path} did not match the RailProfile schema; using default rails`);
    } catch (e) {
      console.warn(`[fx] could not read ${path}; using default rails`, e);
    }
  }
  if (path === RAILS_FIXTURE_PATH) cache = out;
  return out;
}
