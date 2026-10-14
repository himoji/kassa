import { formatMoney, type CaptureEventResponse } from "@kassa/shared";
import { and, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { cardFeeProfiles, cards, notifications, transactions, users } from "../../db/schema.ts";
import { paymentNote, paymentNoteModel, type PaymentFacts } from "../advice/enrich.ts";
import { categoryEn, listBudgets, monthWindow, spendContext } from "../budget/index.ts";
import { clock, isoDate } from "../clock/index.ts";
import { addDays } from "../fx/dates.ts";
import { applyBps } from "../fx/rational.ts";
import { zoneFor } from "../rules/facts.ts";
import { whereLabel } from "./place.ts";
import { merchantDisplayName } from "./service.ts";

/*
 * The `nudge` the iOS Shortcut (or an Android forwarder) shows as a notification right after a tap
 * (docs/SHORTCUT_SETUP.md): what was logged, when and where, the likely place, the category budget after it (or,
 * with no budget, the month so far and spending outside budgets), and fee / DCC warnings Kassa already knows about.
 * It reports results of the capture that just ran and moves no money (I6); the only write is the AI place guess
 * kept on the transaction. English only: a Shortcut has no app locale; the app shows the localised notification.
 */

const SEP = " · ";
const DAY_MS = 86_400_000;

const money = (amountMinor: number, currency: string) => formatMoney(amountMinor, currency, "en");

function isCalendarMonth(periodStart: string, periodEnd: string): boolean {
  return periodStart.endsWith("-01") && addDays(periodEnd, 1).endsWith("-01") && periodStart.slice(0, 7) === periodEnd.slice(0, 7);
}

/** "New card saved: Revolut ••1234 (billed in HUF)" on the first tap of a card Kassa learned (capture/cards.ts). */
async function learnedCardPart(tx: typeof transactions.$inferSelect, db: DbOrTx): Promise<string | null> {
  if (!tx.cardId) return null;
  const learned = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, tx.userId), eq(notifications.kind, "CARD_LEARNED"), sql`${notifications.data}->>'cardId' = ${tx.cardId}`))
    .limit(1);
  if (learned.length === 0) return null;
  const uses = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.cardId, tx.cardId), isNull(transactions.mergedIntoId))).limit(2);
  if (uses.length > 1) return null;
  const card = (await db.select().from(cards).where(eq(cards.id, tx.cardId)))[0];
  if (!card) return null;
  return `New card saved: ${card.last4 ? `${card.label} ••${card.last4}` : card.label} (billed in ${card.billingCurrency})`;
}

/** Card markup on a foreign spend, from the card's rolling-median fee profile (spec §12 fee x-ray). */
async function feePart(tx: typeof transactions.$inferSelect, homeCurrency: string, db: DbOrTx): Promise<string | null> {
  if (!tx.cardId || tx.homeAmountMinor === null) return null;
  const card = (await db.select().from(cards).where(eq(cards.id, tx.cardId)))[0];
  if (!card || card.billingCurrency === tx.currency) return null;
  const profile = (
    await db
      .select()
      .from(cardFeeProfiles)
      .where(and(eq(cardFeeProfiles.cardId, card.id), eq(cardFeeProfiles.fromCurrency, tx.currency), eq(cardFeeProfiles.toCurrency, card.billingCurrency)))
  )[0];
  if (!profile || profile.medianMarkupBps <= 0) return null;
  const fee = applyBps(tx.homeAmountMinor, profile.medianMarkupBps);
  const pct = (profile.medianMarkupBps / 100).toFixed(1).replace(/\.0$/, "");
  return `${card.label} adds ~${pct}% (≈ ${money(fee, homeCurrency)})`;
}

/**
 * DCC (spec §12): a settled DCC flag for this merchant before, or a home-currency charge while the last day's other
 * spending was in a foreign currency (paying abroad, the terminal converted to the home currency).
 */
async function dccPart(tx: typeof transactions.$inferSelect, homeCurrency: string, db: DbOrTx): Promise<string | null> {
  const flags = await db
    .select({ data: notifications.data })
    .from(notifications)
    .where(and(eq(notifications.userId, tx.userId), eq(notifications.kind, "FEES_DCC")));
  const past = flags.map((f) => f.data as { merchantNorm?: unknown; overMidBps?: unknown } | null).find((d) => d?.merchantNorm === tx.merchantNorm);
  if (past) {
    const over = typeof past.overMidBps === "number" ? ` (+${(past.overMidBps / 100).toFixed(1).replace(/\.0$/, "")}%)` : "";
    return `DCC charged here before${over}: pay in local currency`;
  }
  if (tx.currency !== homeCurrency) return null;
  const abroad = await db
    .select({ currency: transactions.currency })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, tx.userId),
        ne(transactions.id, tx.id),
        ne(transactions.currency, homeCurrency),
        isNull(transactions.mergedIntoId),
        gte(transactions.occurredAt, new Date(clock.nowMs() - DAY_MS)),
      ),
    )
    .limit(1);
  const local = abroad[0]?.currency;
  return local ? `Charged in ${homeCurrency}, not ${local}? That is DCC: choose ${local} at the terminal` : null;
}

const ORDINAL = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

function localDay(d: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "Today 10:59", "Yesterday 22:10", "Mon 12 Oct, 10:59" in the user's zone. */
export function whenLabel(at: Date, now: Date, zone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const day = localDay(at, zone);
  if (day === localDay(now, zone)) return `Today ${time}`;
  if (day === localDay(new Date(now.getTime() - DAY_MS), zone)) return `Yesterday ${time}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(at);
  return `${date}, ${time}`;
}

/** "first time here", "3rd visit this month" (calendar month, UTC like budgets), or null. */
async function visitPart(tx: typeof transactions.$inferSelect, db: DbOrTx): Promise<string | null> {
  const same = await db
    .select({ at: transactions.occurredAt })
    .from(transactions)
    .where(and(eq(transactions.userId, tx.userId), eq(transactions.merchantNorm, tx.merchantNorm), isNull(transactions.mergedIntoId), lte(transactions.occurredAt, tx.occurredAt)));
  if (same.length <= 1) return tx.merchantNorm === "unknown" ? null : "first time here";
  const month = monthWindow(isoDate(tx.occurredAt));
  const inMonth = same.filter((r) => isoDate(r.at) >= month.start).length;
  return inMonth >= 2 ? `${ORDINAL(inMonth)} visit this month` : null;
}

interface BudgetLine {
  text: string;
  /** Extra lines (spending outside budgets). */
  more: string[];
  /** Numbers for the AI tip, formatted as shown. */
  facts: PaymentFacts;
}

async function budgetLines(userId: string, category: string, db: DbOrTx): Promise<BudgetLine> {
  const label = categoryEn(category);
  const r = await listBudgets(userId, category, db);
  const b = r.budgets[0];
  if (b) {
    const facts: PaymentFacts = { budget: "yes", budgetLimit: money(b.limitHomeMinor, r.homeCurrency), budgetDaysLeft: b.daysLeft, budgetPace: b.pace };
    if (b.remainingHomeMinor < 0) {
      facts.budgetOverBy = money(-b.remainingHomeMinor, r.homeCurrency);
      return { text: `${label} over budget by ${money(-b.remainingHomeMinor, r.homeCurrency)}`, more: [], facts };
    }
    const usedPct = b.limitHomeMinor > 0 ? Math.floor((b.spentHomeMinor * 100) / b.limitHomeMinor) : 100;
    const leftPct = Math.max(0, 100 - usedPct);
    const when = isCalendarMonth(b.periodStart, b.periodEnd) ? "this month" : `for ${b.daysLeft} days`;
    const left = money(b.remainingHomeMinor, r.homeCurrency);
    // Whole currency units a day: "about HUF 414 a day" reads better than HUF 414.76.
    const perDay = b.daysLeft > 0 ? Math.floor(b.remainingHomeMinor / b.daysLeft / 100) * 100 : 0;
    Object.assign(facts, { budgetLeft: left, budgetLeftPct: leftPct, budgetUsedPct: usedPct });
    let text = `${label} ${leftPct}% left ${when} (${left})`;
    if (b.daysLeft > 1 && perDay > 0) {
      const day = money(perDay, r.homeCurrency).replace(/[.,]00(?!\d)/, "");
      facts.budgetPerDayLeft = day;
      text += `, about ${day} a day`;
    }
    return { text, more: [], facts };
  }
  // No budget for this category: the month so far, against a usual month, and spending outside budgets overall.
  const c = await spendContext(userId, category, db);
  const h = (minor: number) => money(minor, c.homeCurrency);
  const facts: PaymentFacts = {
    budget: "none",
    categoryThisMonth: h(c.category.spentMinor),
    categoryPurchasesThisMonth: c.category.count,
    outsideBudgetsThisMonth: h(c.outsideBudgetsMinor),
    allSpendingThisMonth: h(c.totalMinor),
    daysLeftInMonth: c.month.daysLeft,
  };
  let text = `${label}: no budget · ${h(c.category.spentMinor)} this month (${c.category.count} purchase${c.category.count === 1 ? "" : "s"})`;
  if (c.category.typicalMinor) {
    facts.categoryUsualMonth = h(c.category.typicalMinor);
    text += `, usually ${h(c.category.typicalMinor)}`;
  }
  const overall = [c.outsideBudgetsMinor === c.totalMinor ? `None of this month's spending has a budget` : `Outside budgets ${h(c.outsideBudgetsMinor)}`];
  if (c.incomeUsedPct !== null && c.monthlyIncomeMinor) {
    facts.monthlyIncome = h(c.monthlyIncomeMinor);
    facts.incomeUsedPct = c.incomeUsedPct;
    overall.push(`all spending ${c.incomeUsedPct}% of income`);
  } else overall.push(`all spending ${h(c.totalMinor)}`);
  overall.push(`${c.month.daysLeft} day${c.month.daysLeft === 1 ? "" : "s"} left`);
  return { text, more: [overall.join(SEP)], facts };
}

export interface CaptureNudge {
  /** The whole notification, one line per part (what older Shortcuts show as the notification body). */
  nudge: string;
  /** Short title: amount and place. */
  title: string;
  /** Everything after the title. */
  body: string;
}

const lines = (title: string, body: string[] = []): CaptureNudge => ({ nudge: [title, ...body].join("\n"), title, body: body.join("\n") });

/**
 * The notification after a tap: what was logged and where, when, which place it most likely was, the budget (or,
 * for a category without one, the month so far and spending outside budgets), fee / DCC warnings, and, with the
 * user's AI consent, one tip grounded in those numbers (advice/enrich.ts).
 */
export async function captureNudge(userId: string, r: CaptureEventResponse, db: DbOrTx = getDb()): Promise<CaptureNudge> {
  if (r.status === "UNPARSED") return lines("Kassa could not read this payment. Open Kassa to add it by hand.");
  if (r.status === "IGNORED_INCOMING") {
    const amount = r.amountMinor !== null && r.currency ? `${money(r.amountMinor, r.currency)} ` : "";
    return lines(`Refund ${amount}noted: not counted as spending.`);
  }
  const tx = r.transactionId ? (await db.select().from(transactions).where(and(eq(transactions.id, r.transactionId), eq(transactions.userId, userId))))[0] : undefined;
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!tx || !u) return lines("Logged in Kassa.");
  const display = await merchantDisplayName(userId, tx.merchantNorm, tx.merchantRaw, db);
  const amount = money(tx.amountMinor, tx.currency);
  const home = tx.currency !== u.homeCurrency && tx.homeAmountMinor !== null ? ` (≈ ${money(tx.homeAmountMinor, u.homeCurrency)})` : "";
  if (r.status === "MERGED") return lines(`Already logged: ${amount} at ${display}.`);

  const category = tx.category ?? "other";
  const place = tx.place ?? null;
  const context = [whenLabel(tx.occurredAt, clock.now(), zoneFor(u.region))];
  const where = whereLabel(place);
  if (where) context.push(where);
  const visit = await visitPart(tx, db);
  if (visit) context.push(visit);
  if (place?.processor) context.push(`paid via ${place.processor}`);

  const budget = await budgetLines(userId, category, db);
  const warnings: string[] = [];
  const learned = await learnedCardPart(tx, db);
  if (learned) warnings.push(learned);
  const fee = await feePart(tx, u.homeCurrency, db);
  if (fee) warnings.push(fee);
  const dcc = await dccPart(tx, u.homeCurrency, db);
  if (dcc) warnings.push(dcc);

  let likely: string | null = null;
  let tip: string | null = null;
  const model = await paymentNoteModel(u);
  if (model) {
    const facts: PaymentFacts = {
      amount,
      ...(home ? { amountHome: money(tx.homeAmountMinor!, u.homeCurrency) } : {}),
      category: categoryEn(category),
      merchantShownAs: display,
      ...(place?.city ? { city: place.city } : {}),
      ...(place?.street ? { street: place.street } : {}),
      ...(place?.country ? { country: place.country } : {}),
      ...(visit ? { visit } : {}),
      ...budget.facts,
      ...(fee ? { cardFee: fee } : {}),
      ...(dcc ? { dcc } : {}),
    };
    const note = await paymentNote(model, { merchantText: tx.merchantRaw, facts });
    if (note?.place && place?.source !== "DICTIONARY" && place?.source !== "PAYEE") {
      const sameName = note.place.name.toLowerCase() === display.toLowerCase();
      likely = sameName ? `${display} is a ${note.place.kind}` : `Probably ${note.place.name}, a ${note.place.kind}`;
      await db
        .update(transactions)
        .set({ place: { ...(place ?? {}), name: note.place.name, kind: note.place.kind, source: "AI" } })
        .where(eq(transactions.id, tx.id));
    }
    tip = note?.tip ?? null;
  } else if (place?.kind) likely = `${display} is a ${place.kind}`;

  const body = [context.join(SEP), ...(likely ? [likely] : []), budget.text, ...budget.more, ...warnings, ...(tip ? [`Tip: ${tip}`] : [])];
  return lines(`Logged ${amount}${home} at ${display}`, body);
}
