/*
 * (added 2026-10-18) Can the user's wallet pay a bill, and how. One answer for GET /obligations (money/routes.ts) and
 * the planner's get_obligations, so the screen and the chat agree:
 *
 *   COVERED      one balance pays it, with fees, in time (rules/funding.ts chooseFunding: the route rules will sign);
 *   CONVERTIBLE  no single balance does, but converting first does: `conversions` lists the CONVERT orders (each signed
 *                with the passkey) that bring the bill's own currency balance up to the bill plus its route's fee;
 *                then the bill pays from that balance. One conversion when one balance covers the gap, otherwise the
 *                fewest balances in order of their home-currency value, each bounded by what it can actually deliver;
 *   SHORTFALL    the balances do not cover it even together;
 *   UNKNOWN      balances unreadable or the check failed (never COVERED).
 *
 * Bills of merchants, payees without account details and bills beyond the 45-day horizon are not checked (COVERED,
 * no route), as before.
 *
 * How the bill will be paid decides which balances count (`billRail`, the rail rules will choose): a bank transfer
 * may be funded from any balance (the bank converts on the way), a HANDOFF bill (region CN, or money mode Handoff) is
 * paid by the user in that currency, so only that currency's balance counts and anything else is a conversion first.
 * The coverage forecast (fx/index.ts) draws bills the same way, so the two never disagree about a bill.
 */
import { effectiveSettings, type ConversionPlanStep, type ObligationDto, type PayeeKind, type Preset, type Region, type SettingsOverrides } from "@kassa/shared";

import { maxPayablePerRoute } from "../agent/capacity.ts";
import { isoDate } from "../clock/index.ts";
import { getRoutes } from "../fx/routes.ts";
import { toHome } from "../money/fx.ts";
import { chooseRail, reserveBreachedFor, type WalletBalances } from "../rules/facts.ts";
import { bankRails, chooseFunding } from "../rules/funding.ts";

export type Coverage = Pick<ObligationDto, "coverage" | "bestRoute" | "reserveBreached"> & { conversions?: ConversionPlanStep[] };

export const COVERAGE_HORIZON_DAYS = 45;

/** The rail rules will choose for a bill to this kind of payee (rules/facts.ts chooseRail, no rail requested). */
export function billRail(user: { preset: Preset; overrides: SettingsOverrides; region: Region }, payeeKind: PayeeKind) {
  return chooseRail(undefined, effectiveSettings(user.preset, user.overrides).moneyMode, user.region, payeeKind);
}

export async function coverageOf(
  o: { amountMinor: number; currency: string; dueDate: string; payeeKind: string; payeeAccountHash: string | null },
  c: { userId: string; homeCurrency: string; now: Date; balances: WalletBalances | null; rail?: string; reserveHomeMinor?: number },
): Promise<Coverage> {
  const horizon = isoDate(new Date(c.now.getTime() + COVERAGE_HORIZON_DAYS * 86_400_000));
  if (o.payeeKind === "MERCHANT" || o.payeeAccountHash === null || o.dueDate > horizon) return { coverage: "COVERED", bestRoute: null };
  if (!c.balances) return { coverage: "UNKNOWN", bestRoute: null };
  const base = { userId: c.userId, homeCurrency: c.homeCurrency, now: c.now };
  // A handoff bill is paid in its own currency by the user: only that balance can pay it directly.
  const handoff = c.rail === "HANDOFF";
  const f = await chooseFunding({ ...base, amountMinor: o.amountMinor, currency: o.currency, dueDate: o.dueDate, balances: c.balances, ...(handoff ? { fundingCurrencies: [o.currency] } : {}) });
  if (f.status === "UNKNOWN") return { coverage: "UNKNOWN", bestRoute: null };
  // Decide step 5's protected reserve on the wallet as it would be when the bill is paid (after any conversions): a
  // bill that would leave the wallet below the reserve is refused REFUSE_CAP, so it is no COVERED / CONVERTIBLE here.
  const billHome = (await toHome(o.amountMinor, o.currency, c.homeCurrency, c.now)).amountMinor;
  const reserveOk = async (wallet: WalletBalances) => (await reserveBreachedFor(wallet, c.homeCurrency, c.reserveHomeMinor ?? 0, billHome, c.now)) !== true;
  if (f.status === "OK") {
    if (!(await reserveOk(c.balances))) return { coverage: "SHORTFALL", bestRoute: null, reserveBreached: true };
    const { amountInFundingMinor: _a, totalDebitFundingMinor: _t, ...route } = f.route;
    const direct = route.fundingCurrency === o.currency ? { noConversion: true, balanceCovers: true } : {};
    return { coverage: "COVERED", bestRoute: { ...route, ...direct } };
  }
  const conversions = await conversionPlan(o, { ...c, balances: c.balances });
  if (!conversions) return { coverage: "SHORTFALL", bestRoute: null };
  if (!(await reserveOk(afterConversions(c.balances, conversions)))) return { coverage: "SHORTFALL", bestRoute: null, reserveBreached: true };
  return { coverage: "CONVERTIBLE", bestRoute: null, conversions };
}

/** The wallet after the plan's conversions (each debits its estimate from its source, credits its amount). */
function afterConversions(balances: WalletBalances, plan: ConversionPlanStep[]): WalletBalances {
  const w = new Map(balances.map((b) => [b.currency, b.amountMinor]));
  for (const s of plan) {
    w.set(s.fromCurrency, (w.get(s.fromCurrency) ?? 0) - s.estimatedDebitMinor);
    w.set(s.toCurrency, (w.get(s.toCurrency) ?? 0) + s.amountMinor);
  }
  return [...w].map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

/** The conversions that make the bill payable from its own currency balance, or null when the balances cannot. */
async function conversionPlan(
  o: { amountMinor: number; currency: string; dueDate: string },
  c: { userId: string; homeCurrency: string; now: Date; balances: WalletBalances },
): Promise<ConversionPlanStep[] | null> {
  const base = { userId: c.userId, homeCurrency: c.homeCurrency, now: c.now };
  // What paying the bill from its own currency costs (amount + the route's fee), whatever that balance holds today.
  const own = await chooseFunding({ ...base, amountMinor: o.amountMinor, currency: o.currency, dueDate: o.dueDate, balances: [{ currency: o.currency, amountMinor: Number.MAX_SAFE_INTEGER }] });
  if (own.status !== "OK") return null;
  const have = c.balances.find((b) => b.currency === o.currency)?.amountMinor ?? 0;
  const gap = own.funding.estimatedAmountMinor - Math.max(0, have);
  if (gap <= 0) return null; // the bill's own balance pays it: chooseFunding would have said so
  const others = c.balances.filter((b) => b.currency !== o.currency && b.amountMinor > 0);
  const step = async (amountMinor: number, from: string[]): Promise<ConversionPlanStep | null> => {
    const r = await chooseFunding({ ...base, amountMinor, currency: o.currency, balances: c.balances, fundingCurrencies: from });
    if (r.status !== "OK") return null;
    return { fromCurrency: r.funding.currency, toCurrency: o.currency, amountMinor, estimatedDebitMinor: r.funding.estimatedAmountMinor, routeId: r.funding.routeId };
  };
  // One balance covers the whole gap: the cheapest such conversion.
  const single = await step(gap, others.map((b) => b.currency));
  if (single) return [single];
  // Otherwise the largest balances first (home value), each delivering what its best route can from today's balance.
  const ranked = await Promise.all(others.map(async (b) => ({ b, home: (await toHome(b.amountMinor, b.currency, c.homeCurrency, c.now)).amountMinor })));
  ranked.sort((x, y) => y.home - x.home);
  const today = isoDate(c.now);
  const plan: ConversionPlanStep[] = [];
  let remaining = gap;
  for (const { b } of ranked) {
    if (remaining <= 0) break;
    const price = async (amountMinor: number) =>
      (await getRoutes({ amountMinor, toCurrency: o.currency, homeCurrency: c.homeCurrency, today, balances: [{ currency: b.currency, amountMinor: Number.MAX_SAFE_INTEGER }], rails: bankRails(), top: 50 })).map((r) => ({
        routeId: r.routeId,
        totalDebitFundingMinor: r.totalDebitFundingMinor,
      }));
    const caps = await maxPayablePerRoute(price, b.amountMinor);
    const deliverable = Math.max(0, ...caps.values());
    if (deliverable <= 0) continue;
    const s = await step(Math.min(deliverable, remaining), [b.currency]);
    if (!s) continue;
    plan.push(s);
    remaining -= s.amountMinor;
  }
  return remaining <= 0 ? plan : null;
}
