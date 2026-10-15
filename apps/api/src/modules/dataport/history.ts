import { currencyExponent, type ImportHistory, type ImportItems } from "@kassa/shared";

import { normalizeMerchant } from "../capture/normalize.ts";
import { convertMinor } from "../fx/rational.ts";
import { rates } from "../fx/rates.ts";
import { kindCategory, SPENDING_KINDS } from "./classify.ts";
import { payeeKindOf } from "./mapper.ts";
import type { StatementRow } from "./statement.ts";

/*
 * What the history says, in code (IMPORT_PLAN S8): regular money in (who, how much, how often), payments that recur
 * like bills, spending per category per month, card and conversion costs, the biggest merchants. All amounts are
 * converted to the home currency at the mid rate (fx/rates.ts) of the row's month (the day's rate for FX markups).
 * Suggestions built from it (incomes, bills, budgets) only ever go to the user for review: incomes feed the forecast,
 * bills become unpayable placeholder payees, budgets still need the passkey.
 */

const DAY = 86_400_000;
const isoDay = (d: Date | string) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

type ToHome = (amountMinor: number, currency: string, day: string) => Promise<{ amountMinor: number; exact: boolean }>;

/** Mid-rate conversion with a cache per currency and day (or month). `exact` is false for the static example table. */
export function homeConverter(homeCurrency: string): ToHome {
  const cache = new Map<string, Promise<{ rate: Parameters<typeof convertMinor>[3]; exact: boolean } | null>>();
  return async (amountMinor, currency, day) => {
    if (currency === homeCurrency) return { amountMinor, exact: true };
    const key = `${currency}|${day}`;
    if (!cache.has(key))
      cache.set(
        key,
        rates()
          .getRate(currency, homeCurrency, day)
          .then((q) => ({ rate: q.rate, exact: q.source !== "STATIC_EXAMPLE" }))
          .catch(() => null),
      );
    const q = await cache.get(key)!;
    return q ? { amountMinor: convertMinor(amountMinor, currency, homeCurrency, q.rate), exact: q.exact } : { amountMinor: 0, exact: false };
  };
}

const monthDay = (iso: string) => `${iso.slice(0, 7)}-15`;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return isoDay(target);
}

/** Counterparty key for grouping: merchant normalisation without operation words and placeholders. */
function partyKey(description: string): string {
  return normalizeMerchant(description.replace(/\b(?:zelle|payment|from|to|transfer|перевод|от|для)\b/gi, " ").replace(/\[(?:number|code)\]/g, " ")) || description.toLowerCase();
}

/** "Nice" budget: up to 2 significant figures, rounded up to a 5 (₸83,512 → ₸85,000). */
export function niceLimit(minor: number, exponent = 2): number {
  const major = Math.max(1, minor / 10 ** exponent);
  const step = 5 * 10 ** Math.max(0, Math.floor(Math.log10(major)) - 1);
  return Math.ceil(major / step) * step * 10 ** exponent;
}

export interface HistoryResult {
  history: ImportHistory;
  suggestions: Pick<ImportItems, "incomes" | "bills" | "budgets">;
}

/** History and suggestions from classified rows (see the header comment). `today` places the next due dates. */
export async function buildHistory(rows: StatementRow[], o: { homeCurrency: string; today: string; toHome?: ToHome; categoryOf: (r: StatementRow) => string }): Promise<HistoryResult> {
  const toHome = o.toHome ?? homeConverter(o.homeCurrency);
  const days = rows.map((r) => r.occurredAt.slice(0, 10)).sort();
  const from = days[0] ?? null;
  const to = days.at(-1) ?? null;
  const months = from && to ? Math.max(0.5, (Date.parse(to) - Date.parse(from) + DAY) / (30.44 * DAY)) : 0;
  const perMonth = (minor: number) => Math.round(minor / Math.max(months, 1));

  const spending = rows.filter((r) => r.kind && SPENDING_KINDS.has(r.kind));
  const incoming = rows.filter((r) => r.kind === "INCOME");
  // The account side is what left the account; convert it (a HUF purchase paid from KZT counts at its KZT cost).
  const accountSide = (r: StatementRow) => r.settled ?? { amountMinor: r.amountMinor, currency: r.currency };
  const homeOf = async (r: StatementRow) => Math.abs((await toHome(Math.abs(accountSide(r).amountMinor), accountSide(r).currency, monthDay(r.occurredAt))).amountMinor);

  const byCategory = new Map<string, { total: number; count: number }>();
  const byMerchant = new Map<string, { name: string; total: number; count: number }>();
  let spendTotal = 0;
  let feeTotal = 0;
  let feeCount = 0;
  const spendingHome = await Promise.all(spending.map(homeOf));
  for (const [i, r] of spending.entries()) {
    const h = spendingHome[i]!;
    // Monthly spending is what the user spent on things; transfers to people are reported on their own.
    if (r.kind !== "TRANSFER_OUT") spendTotal += h;
    const cat = kindCategory(r.kind) ?? o.categoryOf(r);
    const c = byCategory.get(cat) ?? { total: 0, count: 0 };
    byCategory.set(cat, { total: c.total + h, count: c.count + 1 });
    if (r.kind === "FEE" || r.kind === "FX_DIFF") {
      feeTotal += h;
      feeCount++;
    }
    if (r.kind === "PURCHASE") {
      const key = partyKey(r.description);
      const m = byMerchant.get(key) ?? { name: r.description, total: 0, count: 0 };
      byMerchant.set(key, { name: m.name, total: m.total + h, count: m.count + 1 });
    }
  }
  const incomeTotal = (await Promise.all(incoming.map(homeOf))).reduce((a, b) => a + b, 0);

  // FX markup: account-side cost vs the purchase at the day's mid rate, on up to 30 foreign purchases spread over the
  // period (rates are fetched in parallel; a day without a published rate is left out, never guessed).
  const allForeign = spending.filter((r) => r.kind === "PURCHASE" && r.settled && r.settled.currency !== r.currency);
  const stride = Math.max(1, Math.ceil(allForeign.length / 30));
  const foreign = allForeign.filter((_, i) => i % stride === 0).slice(0, 30);
  const samples = await Promise.all(
    foreign.map(async (r) => {
      const day = r.occurredAt.slice(0, 10);
      const [mid, paid] = await Promise.all([toHome(Math.abs(r.amountMinor), r.currency, day), toHome(Math.abs(r.settled!.amountMinor), r.settled!.currency, day)]);
      return mid.exact && paid.exact && mid.amountMinor > 0 ? Math.round(((paid.amountMinor - mid.amountMinor) * 10_000) / mid.amountMinor) : null;
    }),
  );
  const bps = samples.filter((x): x is number => x !== null);
  const fxMarkupBps = bps.length >= 3 ? median(bps) : null;
  const foreignHome = (await Promise.all(allForeign.map(homeOf))).reduce((a, b) => a + b, 0);
  const fxCostHomeMinor = fxMarkupBps !== null ? Math.max(0, Math.round((foreignHome * fxMarkupBps) / (10_000 + fxMarkupBps))) : 0;

  // Regular money in: grouped by counterparty. Family sends money irregularly within a month, so the income is the
  // median monthly total over the months it arrived; it counts as monthly when it came in 2+ months.
  const fileMonths = new Map<number, number>();
  for (const f of new Set(rows.map((r) => r.file))) {
    const d = rows.filter((r) => r.file === f).map((r) => Date.parse(r.occurredAt));
    fileMonths.set(f, (Math.max(...d) - Math.min(...d) + DAY) / (30.44 * DAY));
  }
  const incomeGroups = new Map<string, StatementRow[]>();
  for (const r of incoming) incomeGroups.set(partyKey(r.description), [...(incomeGroups.get(partyKey(r.description)) ?? []), r]);
  const incomes: ImportHistory["incomes"] = [];
  for (const group of incomeGroups.values()) {
    const sorted = [...group].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const currency = accountSide(sorted.at(-1)!).currency;
    const perMonthTotals = new Map<string, number>();
    for (const r of sorted) if (accountSide(r).currency === currency) perMonthTotals.set(r.occurredAt.slice(0, 7), (perMonthTotals.get(r.occurredAt.slice(0, 7)) ?? 0) + Math.abs(accountSide(r).amountMinor));
    // Two months seen, or a short statement (under 2 months) where it came twice.
    if (perMonthTotals.size < 2 && !((fileMonths.get(sorted[0]!.file) ?? months) < 2 && group.length >= 2)) continue;
    incomes.push({ source: sorted.at(-1)!.description.slice(0, 80), amount: { amountMinor: median([...perMonthTotals.values()]), currency }, cadence: "MONTHLY", count: group.length, lastDate: isoDay(sorted.at(-1)!.occurredAt) });
  }
  // Biggest first by what arrived over the period.
  incomes.sort((a, b) => b.count * b.amount.amountMinor - a.count * a.amount.amountMinor);

  // Bills: about monthly, similar amount, 3+ months.
  const outGroups = new Map<string, StatementRow[]>();
  // Everyday spending (groceries, cafés, transport, shops) repeats too, but it is a budget, not a bill.
  const everyday = new Set(["groceries", "eating_out", "transport", "shopping", "health", "entertainment", "fees", "cash"]);
  for (const r of spending.filter((x) => (x.kind === "PURCHASE" || x.kind === "TRANSFER_OUT") && !everyday.has(kindCategory(x.kind) ?? o.categoryOf(x)))) outGroups.set(partyKey(r.description), [...(outGroups.get(partyKey(r.description)) ?? []), r]);
  const recurring: ImportHistory["recurring"] = [];
  for (const group of outGroups.values()) {
    const sorted = [...group].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const monthsSeen = new Set(sorted.map((r) => r.occurredAt.slice(0, 7)));
    if (monthsSeen.size < 3 || sorted.length > monthsSeen.size * 1.5) continue;
    const amounts = sorted.map((r) => Math.abs(r.amountMinor));
    const med = median(amounts);
    const close = amounts.filter((a) => Math.abs(a - med) <= med * 0.15).length;
    if (close < sorted.length * 0.75) continue;
    const gaps = sorted.slice(1).map((r, i) => (Date.parse(r.occurredAt) - Date.parse(sorted[i]!.occurredAt)) / DAY);
    const gap = median(gaps);
    if (gap < 24 || gap > 37) continue;
    const last = isoDay(sorted.at(-1)!.occurredAt);
    let next = addMonths(last, 1);
    while (next < o.today) next = addMonths(next, 1);
    recurring.push({ name: sorted.at(-1)!.description.slice(0, 80), amount: { amountMinor: med, currency: sorted.at(-1)!.currency }, count: sorted.length, lastDate: last, nextDate: next, category: kindCategory(sorted[0]!.kind) ?? o.categoryOf(sorted[0]!) });
  }
  recurring.sort((a, b) => b.count - a.count);

  const spendingByCategory = [...byCategory]
    .map(([category, v]) => ({ category, totalHomeMinor: v.total, monthlyHomeMinor: perMonth(v.total), count: v.count }))
    .sort((a, b) => b.totalHomeMinor - a.totalHomeMinor);
  const currencies = new Map<string, { outMinor: number; inMinor: number }>();
  for (const r of rows) {
    if (r.kind === "OWN_TRANSFER") continue;
    const c = currencies.get(r.currency) ?? { outMinor: 0, inMinor: 0 };
    if (r.amountMinor < 0) c.outMinor += -r.amountMinor;
    else c.inMinor += r.amountMinor;
    currencies.set(r.currency, c);
  }

  const history: ImportHistory = {
    homeCurrency: o.homeCurrency,
    from,
    to,
    months: Math.round(months * 10) / 10,
    counts: {
      rows: rows.length,
      spending: spending.length,
      incoming: incoming.length,
      ownTransfers: rows.filter((r) => r.kind === "OWN_TRANSFER").length,
      refunds: rows.filter((r) => r.kind === "REFUND").length,
    },
    spendingByCategory,
    monthlySpendingHomeMinor: perMonth(spendTotal),
    monthlyIncomeHomeMinor: perMonth(incomeTotal),
    incomes: incomes.slice(0, 8),
    recurring: recurring.slice(0, 10),
    fees: { totalHomeMinor: feeTotal, count: feeCount, fxMarkupBps, fxSamples: bps.length, fxCostHomeMinor },
    topMerchants: [...byMerchant.values()].sort((a, b) => b.total - a.total).slice(0, 8).map((m) => ({ name: m.name.slice(0, 80), totalHomeMinor: m.total, count: m.count })),
    currencies: [...currencies].map(([currency, v]) => ({ currency, ...v })),
  };

  // Suggestions for review: the regular incomes, the bills, and a budget per spending category (not transfers).
  const suggestions: HistoryResult["suggestions"] = {
    incomes: history.incomes
      .filter((i) => i.cadence !== "ONCE")
      .slice(0, 5)
      .map((i) => {
        let next = i.lastDate;
        const step = i.cadence === "WEEKLY" ? 0 : i.cadence === "MONTHLY" ? 1 : 4;
        if (step) while (next < o.today) next = addMonths(next, step);
        else while (next < o.today) next = isoDay(new Date(Date.parse(`${next}T12:00:00Z`) + 7 * DAY));
        return { source: i.source.slice(0, 80), currency: i.amount.currency, amountMinor: i.amount.amountMinor, cadence: i.cadence, nextDate: next };
      }),
    bills: history.recurring.slice(0, 6).map((r) => ({
      payeeName: r.name.slice(0, 140),
      payeeKind: payeeKindOf(null, r.name, r.category),
      amountMinor: r.amount.amountMinor,
      currency: r.amount.currency,
      dueDate: r.nextDate,
      recurrence: "MONTHLY" as const,
      category: r.category,
    })),
    budgets: spendingByCategory
      .filter((c) => !["transfers", "other", "fees"].includes(c.category) && /^[a-z0-9_]{1,32}$/.test(c.category) && c.monthlyHomeMinor > 0 && c.totalHomeMinor >= spendTotal * 0.01)
      .slice(0, 10)
      .map((c) => ({ category: c.category, limitHomeMinor: niceLimit(c.monthlyHomeMinor, currencyExponent(o.homeCurrency)) })),
  };
  return { history, suggestions };
}
