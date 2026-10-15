import { currencyExponent, type ImportHistory } from "@kassa/shared";

/*
 * What the history shows, in plain lines (English), written from the numbers by code: the import preview shows them
 * ("What Kassa learned"), the onboarding chat replies with them, and the onboarding model sees them redacted. A model
 * never writes these numbers, so it cannot misstate them.
 */

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(minor / 10 ** currencyExponent(currency));
const month = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" }) : "?");
export const CATEGORY_LABEL = (c: string) => c.replace(/_/g, " ");

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const short = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleString("en", { day: "numeric", month: "short", timeZone: "UTC" });

/** One person's money in, as the statements show it: how often, how much, the plan, and what to be careful about. */
export function incomeLine(i: ImportHistory["incomes"][number]): string {
  const m = (x: number) => money(x, i.amount.currency);
  const parts: string[] = [];
  if (i.regularity === "regular") parts.push(`${i.source}: about ${m(i.amount.amountMinor)} every month (${i.monthsReceived} of ${i.monthsCovered} months)`);
  else if (i.regularity === "irregular" && i.stopped)
    parts.push(`${i.source}: came in ${i.monthsReceived} of ${i.monthsCovered} months (${m(i.minMonthlyMinor)}–${m(i.maxMonthlyMinor)}) but nothing since ${day(i.lastDate)}, so not planned`);
  else if (i.regularity === "irregular")
    parts.push(`${i.source}: money came in ${i.monthsReceived} of ${i.monthsCovered} months, ${m(i.minMonthlyMinor)}–${m(i.maxMonthlyMinor)} a month, so I plan with the average, ${m(i.amount.amountMinor)} a month`);
  else if (i.regularity === "occasional") parts.push(`${i.source}: only ${i.monthsReceived} of ${i.monthsCovered} months (${m(i.minMonthlyMinor)}–${m(i.maxMonthlyMinor)}), not planned as monthly income`);
  else parts.push(`${i.source}: once, ${m(i.maxMonthlyMinor)}, not planned as income`);
  if (i.trend === "down") parts.push("less in recent months");
  if (i.trend === "up") parts.push("more in recent months");
  if (i.stopped && i.regularity !== "irregular") parts.push(`nothing since ${day(i.lastDate)}`);
  if (i.largest) parts.push(`${m(i.largest.amountMinor)} on ${short(i.largest.date)} ${i.largest.paidFor ? `paid for ${i.largest.paidFor}` : "was a one-off"}, kept out of the plan`);
  return `${parts.join("; ")}.`;
}

/** What the statements show, line by line (the reply and, redacted, the model's view). */
export function historyLines(h: ImportHistory): string[] {
  const home = (x: number) => money(x, h.homeCurrency);
  const lines: string[] = [];
  if (h.statements.length) {
    const longest = Math.max(...h.statements.map((s) => s.months));
    lines.push(
      `Statements: ${h.statements
        .map((s) => `${s.bank ?? s.name} ${day(s.from)} – ${day(s.to)} (${s.months < 1.5 ? "about 1 month" : `${Math.round(s.months)} months`}${s.months < longest / 2 ? ", so its numbers cover only that time" : ""})`)
        .join("; ")}.`,
    );
  }
  const oneOffTotal = h.oneOffs.reduce((a, o) => a + o.homeMinor, 0);
  const everyday = Math.max(0, Math.round(h.monthlySpendingHomeMinor - oneOffTotal / Math.max(h.months, 1)));
  const top = h.spendingByCategory.filter((c) => !["transfers", "other"].includes(c.category) && c.monthlyHomeMinor > 0).sort((a, b) => b.monthlyHomeMinor - a.monthlyHomeMinor).slice(0, 4);
  lines.push(`Everyday spending: about ${home(everyday)} a month without transfers and one-off payments. Biggest: ${top.map((c) => `${CATEGORY_LABEL(c.category)} ${home(c.monthlyHomeMinor)}`).join(", ") || "none"}.`);
  const t = h.spendingTrend;
  if (t && t.earlierMonthlyHomeMinor > 0 && Math.abs(t.recentMonthlyHomeMinor - t.earlierMonthlyHomeMinor) > t.earlierMonthlyHomeMinor * 0.2)
    lines.push(`${t.recentMonthlyHomeMinor > t.earlierMonthlyHomeMinor ? "Spending has risen" : "Spending has fallen"}: ${home(t.recentMonthlyHomeMinor)} a month in the last 3 months, ${home(t.earlierMonthlyHomeMinor)} before.`);
  if (h.currencyShift) lines.push(`Since ${month(`${h.currencyShift.since}-15`)} you spend mostly in ${h.currencyShift.to} (before: ${h.currencyShift.from}).`);
  if (h.oneOffs.length) lines.push(`One-off payments, kept out of budgets: ${h.oneOffs.slice(0, 4).map((o) => `${o.name} ${money(o.amount.amountMinor, o.amount.currency)} (${short(o.date)})`).join("; ")}.`);
  const transfers = h.spendingByCategory.find((c) => c.category === "transfers");
  if (transfers) lines.push(`Transfers to other people: about ${home(transfers.monthlyHomeMinor)} a month.`);
  const money_in = h.incomes.filter((i) => i.regularity !== "one_off" || (i.largest?.amountMinor ?? 0) > 0).slice(0, 5);
  if (money_in.length) lines.push(...money_in.map((i) => `Money in. ${incomeLine(i)}`));
  if (h.monthsOverspent > 0 && h.monthly.length) lines.push(`In ${h.monthsOverspent} of ${Math.round(h.months)} months more went out than came in.`);
  if (h.recurring.length) lines.push(`Regular payments: ${h.recurring.slice(0, 4).map((r) => `${r.name} ${money(r.amount.amountMinor, r.amount.currency)} (next ${r.nextDate})`).join("; ")}.`);
  if (h.fees.totalHomeMinor > 0) lines.push(`Bank and conversion fees: ${home(h.fees.totalHomeMinor)} over the period${h.fees.fxMarkupBps !== null ? `; foreign purchases cost about ${(h.fees.fxMarkupBps / 100).toFixed(1)}% over the mid rate` : ""}.`);
  if (h.counts.ownTransfers) lines.push(`${h.counts.ownTransfers} transfers between your own accounts were left out, so nothing is counted twice.`);
  return lines;
}

