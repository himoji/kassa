import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { CardFeesResponse } from "@kassa/shared";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { cardFeeProfiles, cards, notifications, transactions, users } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import { bestCard } from "../fx/fees.ts";
import { applyBps } from "../fx/rational.ts";
import { rates, toHome } from "../fx/index.ts";
import { medianInt } from "../fx/forecast.ts";

/*
 * GET /cards/fees (spec §12 fee x-ray, §16 cards screen): per-card markup by currency pair, fees lost this
 * calendar month, best card per spend currency and DCC warnings.
 */

const SPEND_CURRENCIES = ["EUR", "HUF", "USD", "CNY", "KZT"];

export async function cardFees(userId: string, db: DbOrTx = getDb()): Promise<CardFeesResponse> {
  const now = clock.now();
  const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
  const homeCurrency = u?.homeCurrency ?? "KZT";
  const myCards = await db.select().from(cards).where(eq(cards.userId, userId));
  const ids = myCards.map((c) => c.id);
  const profiles = ids.length ? await db.select().from(cardFeeProfiles).where(inArray(cardFeeProfiles.cardId, ids)) : [];

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lost = await db
    .select({ total: sql<string>`coalesce(sum(greatest(${transactions.feeHomeMinor}, 0)), 0)`, n: sql<string>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), isNotNull(transactions.feeHomeMinor), gte(transactions.occurredAt, monthStart)));

  // Typical spend per currency (last 30 days, median) for the best-card comparison.
  const recent = await db
    .select({ currency: transactions.currency, amountMinor: transactions.amountMinor })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId), gte(transactions.occurredAt, new Date(now.getTime() - 30 * 86_400_000))));
  const today = now.toISOString().slice(0, 10);
  // Pre-compute home conversions needed by bestCard (it is synchronous).
  const homeCache = new Map<string, number>();
  const toHomeSync = (a: number, c: string) => homeCache.get(`${c}|${a}`) ?? 0;

  const bestCardByCurrency: CardFeesResponse["bestCardByCurrency"] = [];
  const profs = profiles.map((p) => ({ cardId: p.cardId, fromCurrency: p.fromCurrency, toCurrency: p.toCurrency, medianMarkupBps: p.medianMarkupBps, fixedFeeMinor: p.fixedFeeMinor }));
  for (const cur of SPEND_CURRENCIES) {
    const amounts = recent.filter((r) => r.currency === cur).map((r) => r.amountMinor);
    const typical = amounts.length ? medianInt(amounts) : 10_000;
    for (const c of myCards) {
      const p = profs.find((x) => x.cardId === c.id && x.fromCurrency === cur && x.toCurrency === c.billingCurrency);
      if (!p) continue;
      const markup = applyBps(typical, p.medianMarkupBps);
      homeCache.set(`${cur}|${markup}`, (await toHome(markup, cur, homeCurrency, today)).amountMinor);
      homeCache.set(`${c.billingCurrency}|${p.fixedFeeMinor}`, (await toHome(p.fixedFeeMinor, c.billingCurrency, homeCurrency, today)).amountMinor);
    }
    const best = bestCard(typical, cur, profs, myCards, toHomeSync);
    if (best) bestCardByCurrency.push({ currency: cur, cardId: best.cardId });
  }

  const dcc = await db
    .select({ data: notifications.data })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, "FEES_DCC")));
  type DccData = { transactionId: string; cardId?: string | null; merchantNorm: string; overMidBps: number; params?: { merchant?: unknown } };
  const dccWarnings = dcc
    .map((n) => n.data as Partial<DccData> | null)
    .filter((d): d is DccData => !!d?.transactionId)
    // `merchant` = the display name the notification showed (Y6); merchantNorm stays as the matching key.
    .map((d) => ({
      transactionId: d.transactionId,
      cardId: d.cardId ?? null,
      merchantNorm: d.merchantNorm,
      merchant: typeof d.params?.merchant === "string" ? d.params.merchant : d.merchantNorm,
      overMidBps: d.overMidBps,
    }));

  // Amounts converted with the labelled offline example table are example values too (cn note 7).
  const probe = await rates().getRate(homeCurrency === "EUR" ? "USD" : "EUR", homeCurrency, today);
  const exampleRates = probe.source === "STATIC_EXAMPLE";

  return {
    homeCurrency,
    profiles: profiles.map((p) => ({ cardId: p.cardId, fromCurrency: p.fromCurrency, toCurrency: p.toCurrency, medianMarkupBps: p.medianMarkupBps, fixedFeeMinor: p.fixedFeeMinor, samples: p.samples })),
    monthlyFeesLostHomeMinor: Number(lost[0]?.total ?? 0),
    bestCardByCurrency,
    dccWarnings,
    // Example values: offline example rates, or seeded profiles before real settlements have produced samples.
    exampleValues: exampleRates || profiles.every((p) => p.samples === 0) || Number(lost[0]?.n ?? 0) === 0,
  };
}
