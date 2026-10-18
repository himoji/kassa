/*
 * The largest bill each funding route can pay from today's balance, so get_routes answers "how much can I pay?"
 * in one call instead of the planner probing amounts. The bound comes from the route optimizer's own debit
 * (amount converted + markup + fixed fee, with its rounding), searched over the bill amount: the debit only grows
 * with the amount, so the search is exact for that pricing.
 */

export interface PricedRoute {
  routeId: string;
  totalDebitFundingMinor: number;
}

/** Upper bound on searched bill amounts (minor units): far above any wallet, and a safe integer. */
const MAX_AMOUNT_MINOR = 2 ** 50;

/**
 * For one funding balance: routeId → the largest bill amount (minor units of the bill currency, ≥ 1) whose total
 * debit fits `balanceMinor`. `price(amountMinor)` lists the routes for that amount without a balance cap (it may
 * still drop a route for its rail cap or arrival date). Routes that cannot pay even 1 minor unit are left out.
 */
export async function maxPayablePerRoute(price: (amountMinor: number) => Promise<PricedRoute[]>, balanceMinor: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor <= 0) return out;
  const cache = new Map<number, Map<string, number>>();
  const debits = async (amountMinor: number) => {
    let d = cache.get(amountMinor);
    if (!d) {
      d = new Map((await price(amountMinor)).map((r) => [r.routeId, r.totalDebitFundingMinor]));
      cache.set(amountMinor, d);
    }
    return d;
  };
  const fits = async (routeId: string, amountMinor: number) => {
    const d = (await debits(amountMinor)).get(routeId);
    return d !== undefined && d <= balanceMinor;
  };
  for (const routeId of (await debits(1)).keys()) {
    if (!(await fits(routeId, 1))) continue;
    // Exponential search for an amount that does not fit, then bisect: lo always fits, hi never does.
    let lo = 1;
    let hi = 2;
    while (hi <= MAX_AMOUNT_MINOR && (await fits(routeId, hi))) {
      lo = hi;
      hi *= 2;
    }
    if (hi > MAX_AMOUNT_MINOR) hi = MAX_AMOUNT_MINOR + 1;
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (await fits(routeId, mid)) lo = mid;
      else hi = mid;
    }
    out.set(routeId, lo);
  }
  return out;
}
