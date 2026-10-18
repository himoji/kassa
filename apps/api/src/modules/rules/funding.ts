/*
 * Funding route for bank transfers (B2, spec §12 route optimizer), chosen at proposal time and bound into
 * the canonical order the user signs. Candidates: funding currency × rail from fixtures/rails.json, limited
 * to routes the bank rail can execute (provider MOCK_BANK, rail BANK_TRANSFER), arriving by the due date,
 * whose balance covers the converted amount + markup + fixed fee. Cheapest by home-currency cost wins.
 *
 * The signed `fundingAmountMinor` is a MAXIMUM debit: the optimizer's estimate plus FX_TOLERANCE_BPS when a
 * conversion is involved (the bank quotes at execution, with its own rounding, possibly on a later rate
 * day), never above the balance. Payments refuses a quote above it (FUNDING_ABOVE_SIGNED_MAX).
 */
import { isoDate } from "../clock/index.ts";
import { loadRails } from "../fx/rails.ts";
import { getRoutes, type RankedRoute } from "../fx/routes.ts";
import { walletBalances, type WalletBalances } from "./facts.ts";

/** Head-room for rate moves / rounding between proposal and bank quote, on converted routes only. */
export const FX_TOLERANCE_BPS = 100;

export type Funding = {
  currency: string;
  /** Signed maximum debit from the funding balance (minor units of `currency`). */
  maxAmountMinor: number;
  /** Optimizer estimate of the debit. */
  estimatedAmountMinor: number;
  routeId: string;
  markupBps: number;
  arrivalDate: string;
};

export type FundingChoice =
  /** `route`: the optimizer's ranked route behind `funding` (shown as the bill's best route, money/routes.ts). */
  | { status: "OK"; funding: Funding; route: RankedRoute }
  /** Balances known and no executable route covers the order. */
  | { status: "NONE" }
  /** Balances unknown (mock bank unreachable): same-currency route bound, the bank's funds check is the backstop. */
  | { status: "UNKNOWN"; funding: Funding | null };

const bankRails = () => loadRails().rails.filter((r) => r.rail === "BANK_TRANSFER" && r.provider === "MOCK_BANK");

function maxFor(estimate: number, converts: boolean, balance: number | null): number {
  if (!converts) return estimate;
  const withTolerance = Math.ceil((estimate * (10_000 + FX_TOLERANCE_BPS)) / 10_000);
  return balance === null ? withTolerance : Math.max(estimate, Math.min(balance, withTolerance));
}

export async function chooseFunding(a: {
  userId: string;
  homeCurrency: string;
  amountMinor: number;
  currency: string;
  now: Date;
  dueDate?: string | undefined;
  /**
   * (added 2026-10-16) Paid from a linked card or bank in this currency: only routes funded in it, and its balance is
   * whatever the route needs (the pull leg brings exactly the signed maximum into the wallet first).
   */
  linkedCurrency?: string | undefined;
  /**
   * (added 2026-10-18) Wallet balances already read by the caller (null = unknown), so a list of bills reads the
   * wallet once. Omitted = read here. Ignored with linkedCurrency.
   */
  balances?: WalletBalances | null;
}): Promise<FundingChoice> {
  const today = isoDate(a.now);
  const rails = a.linkedCurrency ? bankRails().filter((r) => !r.fundingCurrencies || r.fundingCurrencies.includes(a.linkedCurrency!)) : bankRails();
  const balances = a.linkedCurrency
    ? [{ currency: a.linkedCurrency, amountMinor: Number.MAX_SAFE_INTEGER }]
    : a.balances !== undefined
      ? a.balances
      : await walletBalances(a.userId);

  if (!balances) {
    // Unknown balances: bind the same-currency route (no conversion, so the debit is exact).
    const same = rails.find((r) => !r.fundingCurrencies || r.fundingCurrencies.includes(a.currency));
    if (!same) return { status: "UNKNOWN", funding: null };
    const ranked = await getRoutes({ amountMinor: a.amountMinor, toCurrency: a.currency, homeCurrency: a.homeCurrency, today, balances: [{ currency: a.currency, amountMinor: Number.MAX_SAFE_INTEGER }], rails: [same], top: 1 });
    const r = ranked[0];
    if (!r) return { status: "UNKNOWN", funding: null };
    const converts = r.feeCurrency !== r.fundingCurrency;
    return {
      status: "UNKNOWN",
      funding: { currency: a.currency, maxAmountMinor: maxFor(r.totalDebitFundingMinor, converts, null), estimatedAmountMinor: r.totalDebitFundingMinor, routeId: same.id, markupBps: r.markupBps, arrivalDate: r.arrivalDate },
    };
  }

  const rank = (dueDate: string | undefined) =>
    getRoutes({ amountMinor: a.amountMinor, toCurrency: a.currency, homeCurrency: a.homeCurrency, today, dueDate, balances, rails, top: 1 });
  // An overdue bill (due date already passed) is paid as soon as possible; otherwise prefer routes arriving by
  // the due date, and fall back to the cheapest late one rather than not paying at all.
  const due = a.dueDate && a.dueDate >= today ? a.dueDate : undefined;
  let best = (await rank(due))[0];
  if (!best && due) best = (await rank(undefined))[0];
  if (!best) return { status: "NONE" };

  const converts = best.fundingCurrency !== a.currency || best.feeCurrency !== best.fundingCurrency;
  const balance = a.linkedCurrency ? null : (balances.find((b) => b.currency === best.fundingCurrency)?.amountMinor ?? null);
  return {
    status: "OK",
    funding: {
      currency: best.fundingCurrency,
      maxAmountMinor: maxFor(best.totalDebitFundingMinor, converts, balance),
      estimatedAmountMinor: best.totalDebitFundingMinor,
      // RankedRoute.routeId is `${railId}:${fundingCurrency}`; the bank quotes by the rail id (rails.json routeId).
      routeId: best.routeId.slice(0, best.routeId.lastIndexOf(":")),
      markupBps: best.markupBps,
      arrivalDate: best.arrivalDate,
    },
    route: best,
  };
}
