import { formatMoney, type CaptureEventResponse } from "@kassa/shared";
import { and, eq, gte, isNull, ne } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { cardFeeProfiles, cards, notifications, transactions, users } from "../../db/schema.ts";
import { categoryEn, listBudgets } from "../budget/index.ts";
import { clock } from "../clock/index.ts";
import { addDays } from "../fx/dates.ts";
import { applyBps } from "../fx/rational.ts";
import { merchantDisplayName } from "./service.ts";

/*
 * The one-line `nudge` the iOS Shortcut shows as a notification right after an Apple Pay tap (docs/SHORTCUT_SETUP.md):
 * what was logged, the category budget after it, and fee / DCC warnings Kassa already knows about. Read-only: it
 * reports results of the capture that just ran (budget pace, card fee profile, past DCC flags) and changes nothing
 * (I6). English only: a Shortcut has no app locale; the app shows the localised `notification` instead.
 */

const SEP = " · ";
const DAY_MS = 86_400_000;

const money = (amountMinor: number, currency: string) => formatMoney(amountMinor, currency, "en");

function isCalendarMonth(periodStart: string, periodEnd: string): boolean {
  return periodStart.endsWith("-01") && addDays(periodEnd, 1).endsWith("-01") && periodStart.slice(0, 7) === periodEnd.slice(0, 7);
}

async function budgetPart(userId: string, category: string, db: DbOrTx): Promise<string> {
  const label = categoryEn(category);
  const r = await listBudgets(userId, category, db);
  const b = r.budgets[0];
  if (!b) return label;
  if (b.remainingHomeMinor < 0) return `${label} over budget by ${money(-b.remainingHomeMinor, r.homeCurrency)}`;
  const usedPct = b.limitHomeMinor > 0 ? Math.floor((b.spentHomeMinor * 100) / b.limitHomeMinor) : 100;
  const leftPct = Math.max(0, 100 - usedPct);
  const when = isCalendarMonth(b.periodStart, b.periodEnd) ? "this month" : `for ${b.daysLeft} days`;
  return `${label} ${leftPct}% left ${when}`;
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

export async function captureNudge(userId: string, r: CaptureEventResponse, db: DbOrTx = getDb()): Promise<string> {
  if (r.status === "UNPARSED") return "Kassa could not read this payment. Open Kassa to add it by hand.";
  if (r.status === "IGNORED_INCOMING") {
    const amount = r.amountMinor !== null && r.currency ? `${money(r.amountMinor, r.currency)} ` : "";
    return `Refund ${amount}noted: not counted as spending.`;
  }
  const tx = r.transactionId ? (await db.select().from(transactions).where(and(eq(transactions.id, r.transactionId), eq(transactions.userId, userId))))[0] : undefined;
  const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
  if (!tx || !u) return "Logged in Kassa.";
  const display = await merchantDisplayName(userId, tx.merchantNorm, tx.merchantRaw, db);
  const amount = money(tx.amountMinor, tx.currency);
  const home = tx.currency !== u.homeCurrency && tx.homeAmountMinor !== null ? ` (≈ ${money(tx.homeAmountMinor, u.homeCurrency)})` : "";
  if (r.status === "MERGED") return `Already logged: ${amount} at ${display}.`;
  const parts = [`Logged ${amount}${home} at ${display}`, await budgetPart(userId, tx.category ?? "other", db)];
  const fee = await feePart(tx, u.homeCurrency, db);
  if (fee) parts.push(fee);
  const dcc = await dccPart(tx, u.homeCurrency, db);
  if (dcc) parts.push(dcc);
  return parts.join(SEP);
}
