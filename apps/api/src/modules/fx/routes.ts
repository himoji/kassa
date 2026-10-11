import type { RouteDto } from "@kassa/shared";

import { addBusinessDays } from "./dates.ts";
import { loadRails, type RailProfile } from "./rails.ts";
import { applyBps, convertMinor } from "./rational.ts";
import { rates, type RatesService } from "./rates.ts";

/*
 * Route optimizer (spec §12). For each funding currency × rail: keep routes that arrive by the due date
 * and fit the balance / rail caps; cost = toHome(feeFixed) + toHome(A_in_funding × markupBps / 10000);
 * rank by cost, return the top 3 with savings versus the worst feasible option.
 * Same-currency routes carry no conversion, so their markup term is 0.
 */

export interface RouteRequest {
  /** Bill amount in `toCurrency` minor units. */
  amountMinor: number;
  toCurrency: string;
  homeCurrency: string;
  /** ISO date; `today` (from Clock) is the send date. */
  today: string;
  dueDate?: string | undefined;
  /** Funding balances; a currency absent here is not a funding option. */
  balances: Array<{ currency: string; amountMinor: number }>;
  /** Restrict to these funding currencies (optional). */
  fundingCurrencies?: string[] | undefined;
  rails?: RailProfile[];
  top?: number;
}

export interface RankedRoute extends RouteDto {
  amountInFundingMinor: number;
  totalDebitFundingMinor: number;
}

export async function getRoutes(req: RouteRequest, svc: RatesService = rates()): Promise<RankedRoute[]> {
  const rails = req.rails ?? loadRails().rails;
  const candidates: Omit<RankedRoute, "savingsVsWorstHomeMinor">[] = [];
  for (const bal of req.balances) {
    if (req.fundingCurrencies && !req.fundingCurrencies.includes(bal.currency)) continue;
    for (const r of rails) {
      if (r.fundingCurrencies && !r.fundingCurrencies.includes(bal.currency)) continue;
      if (r.toCurrencies && !r.toCurrencies.includes(req.toCurrency)) continue;
      const arrivalDate = r.settlementDays === 0 ? req.today : addBusinessDays(req.today, r.settlementDays);
      if (req.dueDate && arrivalDate > req.dueDate) continue;

      const converts = bal.currency !== req.toCurrency;
      const amountInFundingMinor = converts
        ? (await svc.convert(req.amountMinor, req.toCurrency, bal.currency, req.today)).amountMinor
        : req.amountMinor;
      const markupFundingMinor = converts ? applyBps(amountInFundingMinor, r.markupBps) : 0;
      const feeInFundingMinor =
        r.feeCurrency === bal.currency
          ? r.feeFixedMinor
          : (await svc.convert(r.feeFixedMinor, r.feeCurrency, bal.currency, req.today)).amountMinor;
      const totalDebitFundingMinor = amountInFundingMinor + markupFundingMinor + feeInFundingMinor;
      if (totalDebitFundingMinor > bal.amountMinor) continue; // balance cap
      if (r.maxAmountMinor !== undefined && amountInFundingMinor > r.maxAmountMinor) continue; // rail cap

      const feeHome = await toHomeMinor(r.feeFixedMinor, r.feeCurrency, req.homeCurrency, req.today, svc);
      const markupHome = await toHomeMinor(markupFundingMinor, bal.currency, req.homeCurrency, req.today, svc);
      candidates.push({
        routeId: `${r.id}:${bal.currency}`,
        label: r.label,
        fundingCurrency: bal.currency,
        rail: r.rail,
        feeFixedMinor: r.feeFixedMinor,
        feeCurrency: r.feeCurrency,
        markupBps: converts ? r.markupBps : 0,
        settlementDays: r.settlementDays,
        arrivalDate,
        costHomeMinor: feeHome + markupHome,
        amountInFundingMinor,
        totalDebitFundingMinor,
      });
    }
  }
  if (candidates.length === 0) return [];
  // Stable tie-break: earlier arrival, then routeId, so the ranking is deterministic.
  candidates.sort(
    (a, b) => a.costHomeMinor - b.costHomeMinor || a.arrivalDate.localeCompare(b.arrivalDate) || a.routeId.localeCompare(b.routeId),
  );
  const worst = candidates[candidates.length - 1]!.costHomeMinor;
  return candidates
    .slice(0, req.top ?? 3)
    .map((c) => ({ ...c, savingsVsWorstHomeMinor: worst - c.costHomeMinor }));
}

/**
 * The direct route for a bill paid from a balance in the same currency (p1 B10): no conversion, markup 0, the
 * cheapest same-currency rail arriving by the due date. Ignores the balance cap so the user always sees the direct
 * option; `balanceCovers` says whether today's balance in that currency pays amount + fees. null = no such rail.
 */
export async function directRoute(
  req: Omit<RouteRequest, "fundingCurrencies" | "top">,
  svc: RatesService = rates(),
): Promise<(RankedRoute & { noConversion: true; balanceCovers: boolean }) | null> {
  const balance = req.balances.find((b) => b.currency === req.toCurrency)?.amountMinor ?? 0;
  const best = (
    await getRoutes({ ...req, balances: [{ currency: req.toCurrency, amountMinor: Number.MAX_SAFE_INTEGER }], fundingCurrencies: [req.toCurrency], top: 1 }, svc)
  )[0];
  if (!best) return null;
  return { ...best, savingsVsWorstHomeMinor: 0, noConversion: true, balanceCovers: best.totalDebitFundingMinor <= balance };
}

async function toHomeMinor(amountMinor: number, currency: string, home: string, date: string, svc: RatesService): Promise<number> {
  if (amountMinor === 0 || currency === home) return amountMinor;
  const q = await svc.getRate(currency, home, date);
  return convertMinor(amountMinor, currency, home, q.rate);
}

/** Fastify plugin (Track A's server mounts modules/fx/routes.ts by its default export): GET /fx/rates. */
export { default } from "./http.ts";
