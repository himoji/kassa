import { currencyExponent, type ImportHistory, type ImportItems } from "@kassa/shared";

import { normalizeMerchant } from "../capture/normalize.ts";
import { convertMinor } from "../fx/rational.ts";
import { rates } from "../fx/rates.ts";
import { kindCategory, SPENDING_KINDS } from "./classify.ts";
import { payeeKindOf } from "./mapper.ts";
import { latinToken, type StatementRow } from "./statement.ts";

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

/**
 * The same person across banks and scripts: "Zelle payment from KAIRAT SEITKALI" and "Кайрат С." are one sender. A
 * description of two or three name words keys on the first name in Latin letters plus the next word's initial.
 */
export function personKey(description: string): string | null {
  const words = description
    .replace(/\bconf(?:irmation)?\s*#?\s*\S+/gi, " ")
    .replace(/\b(?:zelle|payment|from|to|transfer)\b/gi, " ")
    .replace(/\[(?:number|code)\]|[;,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2 || words.length > 3 || !words.every((w) => /^\p{L}[\p{L}'-]*\.?$/u.test(w))) return null;
  const first = latinToken(words[0]!);
  const initial = latinToken(words[1]!).slice(0, 1);
  return first.length >= 3 && initial ? `person:${first.replace(/y/g, "i").replace(/q/g, "k")} ${initial}` : null;
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

/** A statement as uploaded: its index in the upload, its period (header, else first and last row), name and bank. */
export interface StatementSpan {
  file: number;
  name: string;
  bank: string | null;
  from: string;
  to: string;
}

const monthKey = (iso: string) => iso.slice(0, 7);
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Months a period touches, each with the share of its days the period covers (0 < weight ≤ 1). */
export function monthWeights(from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  let d = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  while (d <= end) {
    const m = monthKey(new Date(d).toISOString());
    out.set(m, (out.get(m) ?? 0) + 1 / daysIn(m));
    d += DAY;
  }
  for (const [m, w] of out) out.set(m, Math.min(1, Math.round(w * 1000) / 1000));
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Coefficient of variation (spread relative to the mean). */
const cv = (xs: number[]) => {
  const m = mean(xs);
  return m ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m : 0;
};
/** Down to 2 significant figures (a plan, not a promise: ₸213,412 → ₸210,000). */
function roundDown2(minor: number, exponent: number): number {
  const major = minor / 10 ** exponent;
  if (major < 10) return Math.floor(major) * 10 ** exponent;
  const step = 10 ** (Math.floor(Math.log10(major)) - 1);
  return Math.floor(major / step) * step * 10 ** exponent;
}

/**
 * History and suggestions from classified rows (see the header comment). Every average is taken over the months the
 * statements actually cover (a one-month statement is not spread over a year; a partial month counts by its share of
 * days), and money from one person is judged by how it really arrived: in how many covered months, how much it varied,
 * whether it is falling or has stopped, and one large transfer is kept out of the monthly plan.
 */
export async function buildHistory(
  rows: StatementRow[],
  o: { homeCurrency: string; today: string; toHome?: ToHome; categoryOf: (r: StatementRow) => string; statements?: StatementSpan[] },
): Promise<HistoryResult> {
  const toHome = o.toHome ?? homeConverter(o.homeCurrency);
  const exp = currencyExponent(o.homeCurrency);

  // Statement periods: as given (header), else each file's first and last row.
  const spans: StatementSpan[] = [...new Set(rows.map((r) => r.file))].map((f) => {
    const given = o.statements?.find((s) => s.file === f);
    const d = rows.filter((r) => r.file === f).map((r) => r.occurredAt.slice(0, 10)).sort();
    return given ?? { file: f, name: `file ${f + 1}`, bank: null, from: d[0]!, to: d.at(-1)! };
  });
  const fileWeights = new Map(spans.map((s) => [s.file, monthWeights(s.from, s.to)]));
  // Union coverage: per month the largest share any statement covers, and how many statements touch it.
  const coverage = new Map<string, { weight: number; statements: number }>();
  for (const w of fileWeights.values())
    for (const [m, x] of w) {
      const c = coverage.get(m) ?? { weight: 0, statements: 0 };
      coverage.set(m, { weight: Math.max(c.weight, x), statements: c.statements + 1 });
    }
  const months = [...coverage.keys()].sort();
  const coveredMonths = [...coverage.values()].reduce((a, c) => a + c.weight, 0);
  const perMonth = (minor: number) => Math.round(minor / Math.max(coveredMonths, 1));
  const from = spans.map((s) => s.from).sort()[0] ?? null;
  const to = spans.map((s) => s.to).sort().at(-1) ?? null;

  const spending = rows.filter((r) => r.kind && SPENDING_KINDS.has(r.kind));
  const incoming = rows.filter((r) => r.kind === "INCOME");
  // The account side is what left the account; convert it (a HUF purchase paid from KZT counts at its KZT cost).
  const accountSide = (r: StatementRow) => r.settled ?? { amountMinor: r.amountMinor, currency: r.currency };
  const homeOf = async (r: StatementRow) => Math.abs((await toHome(Math.abs(accountSide(r).amountMinor), accountSide(r).currency, monthDay(r.occurredAt))).amountMinor);
  const spendingHome = new Map<StatementRow, number>();
  (await Promise.all(spending.map(homeOf))).forEach((h, i) => spendingHome.set(spending[i]!, h));
  const incomeHome = new Map<StatementRow, number>();
  (await Promise.all(incoming.map(homeOf))).forEach((h, i) => incomeHome.set(incoming[i]!, h));
  const categoryOfRow = (r: StatementRow) => kindCategory(r.kind) ?? o.categoryOf(r);

  // One-off payments: a single purchase far above the usual (≥ 25 % of a typical month and ≥ 8× the median purchase).
  const purchases = spending.filter((r) => r.kind === "PURCHASE");
  const everydayTotal = spending.filter((r) => r.kind !== "TRANSFER_OUT").reduce((a, r) => a + spendingHome.get(r)!, 0);
  const typicalMonth = perMonth(everydayTotal);
  const medianPurchase = median(purchases.map((r) => spendingHome.get(r)!));
  // A payment to the same party in 3+ different months (rent, a subscription) is regular, never a one-off.
  const partyMonths = new Map<string, Set<string>>();
  for (const r of spending) {
    const k = partyKey(r.description);
    partyMonths.set(k, (partyMonths.get(k) ?? new Set()).add(r.occurredAt.slice(0, 7)));
  }
  const repeats = (r: StatementRow) => (partyMonths.get(partyKey(r.description))?.size ?? 0) >= 3;
  const oneOffRows = new Set(
    purchases
      .filter((r) => !repeats(r) && spendingHome.get(r)! >= Math.max(typicalMonth * 0.25, medianPurchase * 8))
      .sort((a, b) => spendingHome.get(b)! - spendingHome.get(a)!)
      .slice(0, 8),
  );

  const byCategory = new Map<string, { total: number; count: number; everyday: number }>();
  const byMerchant = new Map<string, { name: string; total: number; count: number }>();
  let spendTotal = 0;
  let feeTotal = 0;
  let feeCount = 0;
  const monthly = new Map<string, { spending: number; transfers: number; income: number; byCategory: Map<string, number>; byCurrency: Map<string, number> }>();
  const monthOf = (m: string) => {
    if (!monthly.has(m)) monthly.set(m, { spending: 0, transfers: 0, income: 0, byCategory: new Map(), byCurrency: new Map() });
    return monthly.get(m)!;
  };
  for (const r of spending) {
    const h = spendingHome.get(r)!;
    const cat = categoryOfRow(r);
    const c = byCategory.get(cat) ?? { total: 0, count: 0, everyday: 0 };
    byCategory.set(cat, { total: c.total + h, count: c.count + 1, everyday: c.everyday + (oneOffRows.has(r) ? 0 : h) });
    const mo = monthOf(monthKey(r.occurredAt));
    if (r.kind === "TRANSFER_OUT") mo.transfers += h;
    else {
      // Monthly spending is what the user spent on things; transfers to people are reported on their own.
      spendTotal += h;
      mo.spending += h;
      mo.byCategory.set(cat, (mo.byCategory.get(cat) ?? 0) + h);
      if (r.kind === "PURCHASE") mo.byCurrency.set(r.currency, (mo.byCurrency.get(r.currency) ?? 0) + h);
    }
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
  let incomeTotal = 0;
  for (const r of incoming) {
    incomeTotal += incomeHome.get(r)!;
    monthOf(monthKey(r.occurredAt)).income += incomeHome.get(r)!;
  }

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
  const foreignHome = allForeign.reduce((a, r) => a + spendingHome.get(r)!, 0);
  const fxCostHomeMinor = fxMarkupBps !== null ? Math.max(0, Math.round((foreignHome * fxMarkupBps) / (10_000 + fxMarkupBps))) : 0;

  // Money in, per person: judged over the months that person's statements cover, in the home currency (the same parent
  // can send tenge to one bank and dollars to another).
  const incomeGroups = new Map<string, StatementRow[]>();
  for (const r of incoming) {
    const key = personKey(r.description) ?? partyKey(r.description);
    incomeGroups.set(key, [...(incomeGroups.get(key) ?? []), r]);
  }
  const incomes: ImportHistory["incomes"] = [];
  for (const group of incomeGroups.values()) {
    const sorted = [...group].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const currencies = new Set(sorted.map((r) => accountSide(r).currency));
    // One currency: amounts as received; several: in the home currency.
    const currency = currencies.size === 1 ? [...currencies][0]! : o.homeCurrency;
    const amountOf = (r: StatementRow) => (currencies.size === 1 ? Math.abs(accountSide(r).amountMinor) : incomeHome.get(r)!);
    // Months this person could have shown up in: the union of their statements' months, with partial months weighted.
    const weights = new Map<string, number>();
    for (const f of new Set(sorted.map((r) => r.file))) for (const [m, w] of fileWeights.get(f) ?? []) weights.set(m, Math.max(weights.get(m) ?? 0, w));
    const covered = [...weights.keys()].sort();
    const coveredWeight = [...weights.values()].reduce((a, b) => a + b, 0);
    const totals = new Map<string, number>(covered.map((m) => [m, 0]));
    for (const r of sorted) totals.set(monthKey(r.occurredAt), (totals.get(monthKey(r.occurredAt)) ?? 0) + amountOf(r));
    // Money sent for one payment is not income: a transfer (≥ 1.5× the usual month) followed within 3 days by one-off
    // spending of about its size is earmarked; so is one transfer ≥ 3× the usual month. Both stay out of the plan; the
    // biggest is reported, with what it paid for.
    const nonzero = [...totals.values()].filter((x) => x > 0);
    const usual = median(nonzero);
    const earmarked: { row: StatementRow; paidFor: string | null }[] = [];
    if (nonzero.length >= 3) {
      for (const r of sorted) {
        if (amountOf(r) < usual * 1.5) continue;
        const t = Date.parse(r.occurredAt);
        const near = [...oneOffRows].filter((x) => Math.abs(Date.parse(x.occurredAt) - t) <= 3 * DAY);
        const nearHome = near.reduce((a, x) => a + spendingHome.get(x)!, 0);
        const match = near.length > 0 && nearHome >= incomeHome.get(r)! * 0.7 && nearHome <= incomeHome.get(r)! * 1.3;
        if (match) earmarked.push({ row: r, paidFor: near.map((x) => x.description).join(", ").slice(0, 120) });
      }
      const biggest = sorted.reduce((a, r) => (amountOf(r) > amountOf(a) ? r : a), sorted[0]!);
      if (!earmarked.some((e) => e.row === biggest) && amountOf(biggest) >= usual * 3) earmarked.push({ row: biggest, paidFor: null });
    }
    for (const e of earmarked) totals.set(monthKey(e.row.occurredAt), totals.get(monthKey(e.row.occurredAt))! - amountOf(e.row));
    const top = earmarked.sort((a, b) => amountOf(b.row) - amountOf(a.row))[0];
    const largest: ImportHistory["incomes"][number]["largest"] = top ? { date: isoDay(top.row.occurredAt), amountMinor: amountOf(top.row), paidFor: top.paidFor } : null;
    const values = covered.map((m) => totals.get(m) ?? 0);
    const received = values.filter((x) => x > 0);
    const monthsReceived = received.length;
    if (monthsReceived === 0 && !largest) continue;
    const ratio = coveredWeight ? monthsReceived / Math.max(1, Math.round(coveredWeight)) : 0;
    const regularity: ImportHistory["incomes"][number]["regularity"] =
      coveredWeight < 2 ? (sorted.length >= 2 ? "irregular" : "one_off")
      : monthsReceived <= 1 ? "one_off"
      : ratio >= 0.8 && cv(received) <= 0.4 ? "regular"
      : ratio <= 0.4 ? "occasional"
      : "irregular";
    const average = Math.round(values.reduce((a, b) => a + b, 0) / Math.max(coveredWeight, 1));
    // The plan: a regular source's usual month; otherwise the honest average, months without money counted as zero.
    const plan = regularity === "regular" ? median(received) : roundDown2(average, currencyExponent(currency));
    let trend: "up" | "down" | "flat" | null = null;
    if (covered.length >= 6) {
      const recent = mean(values.slice(-3));
      const earlier = mean(values.slice(0, -3));
      trend = earlier === 0 ? (recent > 0 ? "up" : "flat") : recent > earlier * 1.3 ? "up" : recent < earlier * 0.7 ? "down" : "flat";
    }
    const periodEnd = spans.filter((sp) => sorted.some((r) => r.file === sp.file)).map((sp) => sp.to).sort().at(-1)!;
    const lastDate = isoDay(sorted.at(-1)!.occurredAt);
    const stopped = regularity !== "one_off" && coveredWeight >= 3 && Date.parse(periodEnd) - Date.parse(lastDate) > 60 * DAY;
    // The name as the bank prints it, in the user's home script when one statement has it (Cyrillic for KZT).
    const named = [...sorted].reverse().find((r) => /[\u0400-\u04ff]/.test(r.description) === (o.homeCurrency === "KZT")) ?? sorted.at(-1)!;
    incomes.push({
      source: named.description.slice(0, 80),
      amount: { amountMinor: plan, currency },
      cadence: regularity === "one_off" ? "ONCE" : "MONTHLY",
      count: group.length,
      lastDate,
      regularity,
      monthsReceived,
      monthsCovered: Math.max(1, Math.round(coveredWeight)),
      minMonthlyMinor: received.length ? Math.min(...received) : 0,
      maxMonthlyMinor: received.length ? Math.max(...received) : 0,
      medianMonthlyMinor: median(received),
      trend,
      stopped,
      largest,
    });
  }
  // Biggest first by what arrived over the period.
  incomes.sort((a, b) => b.medianMonthlyMinor * b.monthsReceived + (b.largest?.amountMinor ?? 0) - (a.medianMonthlyMinor * a.monthsReceived + (a.largest?.amountMinor ?? 0)));

  // Bills: about monthly, similar amount, 3+ months.
  const outGroups = new Map<string, StatementRow[]>();
  // Everyday spending (groceries, cafés, transport, shops) repeats too, but it is a budget, not a bill.
  const everyday = new Set(["groceries", "eating_out", "transport", "shopping", "health", "entertainment", "fees", "cash"]);
  for (const r of spending.filter((x) => (x.kind === "PURCHASE" || x.kind === "TRANSFER_OUT") && !everyday.has(categoryOfRow(x)))) outGroups.set(partyKey(r.description), [...(outGroups.get(partyKey(r.description)) ?? []), r]);
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
    recurring.push({ name: sorted.at(-1)!.description.slice(0, 80), amount: { amountMinor: med, currency: sorted.at(-1)!.currency }, count: sorted.length, lastDate: last, nextDate: next, category: categoryOfRow(sorted[0]!) });
  }
  recurring.sort((a, b) => b.count - a.count);

  const spendingByCategory = [...byCategory]
    // Monthly is everyday spending (one-off payments left out); the total keeps everything.
    .map(([category, v]) => ({ category, totalHomeMinor: v.total, monthlyHomeMinor: perMonth(v.everyday), count: v.count }))
    .sort((a, b) => b.totalHomeMinor - a.totalHomeMinor);
  const currencies = new Map<string, { outMinor: number; inMinor: number }>();
  for (const r of rows) {
    if (r.kind === "OWN_TRANSFER") continue;
    const c = currencies.get(r.currency) ?? { outMinor: 0, inMinor: 0 };
    if (r.amountMinor < 0) c.outMinor += -r.amountMinor;
    else c.inMinor += r.amountMinor;
    currencies.set(r.currency, c);
  }

  // Month by month, over the covered months only.
  const series = months.map((m) => {
    const x = monthly.get(m);
    return { month: m, spendingHomeMinor: x?.spending ?? 0, transfersHomeMinor: x?.transfers ?? 0, incomeHomeMinor: x?.income ?? 0, statements: coverage.get(m)!.statements };
  });
  // Trend on full months covered by the usual number of statements (a short extra statement would bias one month).
  const usualCount = median(series.map((x) => x.statements));
  const full = series.filter((x) => x.statements === usualCount && coverage.get(x.month)!.weight >= 0.9);
  const oneOffByMonth = new Map<string, number>();
  for (const r of oneOffRows) oneOffByMonth.set(monthKey(r.occurredAt), (oneOffByMonth.get(monthKey(r.occurredAt)) ?? 0) + spendingHome.get(r)!);
  const everydayOf = (x: (typeof series)[number]) => x.spendingHomeMinor - (oneOffByMonth.get(x.month) ?? 0);
  const spendingTrend = full.length >= 6 ? { recentMonthlyHomeMinor: Math.round(mean(full.slice(-3).map(everydayOf))), earlierMonthlyHomeMinor: Math.round(mean(full.slice(0, -3).map(everydayOf))) } : null;
  const peak = [...series].sort((a, b) => b.spendingHomeMinor - a.spendingHomeMinor)[0];
  const peakCats = peak ? [...(monthly.get(peak.month)?.byCategory ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]) : [];
  // The peak's cause: a one-off payment that made up half of it, else its biggest category.
  const peakOneOff = peak ? [...oneOffRows].filter((r) => monthKey(r.occurredAt) === peak.month).sort((a, b) => spendingHome.get(b)! - spendingHome.get(a)!)[0] : undefined;
  const peakMonth =
    peak && peak.spendingHomeMinor > 0 && peakCats[0]
      ? {
          month: peak.month,
          spendingHomeMinor: peak.spendingHomeMinor,
          category: peakCats[0][0],
          categoryHomeMinor: peakCats[0][1],
          oneOff: peakOneOff && spendingHome.get(peakOneOff)! >= peak.spendingHomeMinor * 0.5 ? peakOneOff.description.slice(0, 80) : null,
        }
      : null;

  // Where the money is spent: the main purchase currency per month; a switch that holds to the end is a move.
  const mainCurrency = months.map((m) => [...(monthly.get(m)?.byCurrency ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
  let currencyShift: ImportHistory["currencyShift"] = null;
  const last = mainCurrency.at(-1);
  if (last) {
    let i = mainCurrency.length - 1;
    while (i > 0 && (mainCurrency[i - 1] === last || mainCurrency[i - 1] === null)) i--;
    const before = mainCurrency.slice(0, i).filter((c): c is string => !!c);
    const prev = before.at(-1);
    if (prev && prev !== last && mainCurrency.length - i >= 2 && before.filter((c) => c === prev).length >= 2) currencyShift = { from: prev, to: last, since: months[i]! };
  }

  const history: ImportHistory = {
    homeCurrency: o.homeCurrency,
    from,
    to,
    months: Math.round(coveredMonths * 10) / 10,
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
    statements: spans.map((sp) => ({ name: sp.name.slice(0, 200), bank: sp.bank, from: sp.from, to: sp.to, months: Math.round([...(fileWeights.get(sp.file) ?? new Map()).values()].reduce((a, b) => a + b, 0) * 10) / 10 })),
    monthly: series.slice(-24),
    spendingTrend,
    peakMonth,
    oneOffs: [...oneOffRows].map((r) => ({ date: isoDay(r.occurredAt), name: r.description.slice(0, 80), homeMinor: spendingHome.get(r)!, amount: { amountMinor: Math.abs(r.amountMinor), currency: r.currency } })),
    currencyShift,
    notes: [],
    monthsOverspent: series.filter((x) => coverage.get(x.month)!.weight >= 0.9 && x.spendingHomeMinor + x.transfersHomeMinor > x.incomeHomeMinor).length,
  };

  // Suggestions for review: money in that keeps coming (regular or irregular, at its planned amount), the bills, and a
  // budget per spending category from everyday spending (one-off payments left out; not transfers, fees or "other").
  const suggestions: HistoryResult["suggestions"] = {
    incomes: history.incomes
      .filter((i) => (i.regularity === "regular" || i.regularity === "irregular") && !i.stopped && i.amount.amountMinor > 0)
      .slice(0, 5)
      .map((i) => {
        let next = i.lastDate;
        while (next < o.today) next = addMonths(next, 1);
        return { source: i.source.slice(0, 80), currency: i.amount.currency, amountMinor: i.amount.amountMinor, cadence: "MONTHLY" as const, nextDate: next };
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
    budgets: [...byCategory]
      .map(([category, v]) => ({ category, monthly: perMonth(v.everyday) }))
      .filter((c) => !["transfers", "other", "fees"].includes(c.category) && /^[a-z0-9_]{1,32}$/.test(c.category) && c.monthly > 0 && c.monthly * Math.max(coveredMonths, 1) >= spendTotal * 0.01)
      .sort((a, b) => b.monthly - a.monthly)
      .slice(0, 10)
      .map((c) => ({ category: c.category, limitHomeMinor: niceLimit(c.monthly, exp) })),
  };
  return { history, suggestions };
}
