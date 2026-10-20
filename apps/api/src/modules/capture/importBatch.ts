import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { ImportTransaction } from "@kassa/shared";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { cards, payees, transactions, users } from "../../db/schema.ts";
import { clock, isoDate } from "../clock/index.ts";
import { settlementFee } from "../fx/fees.ts";
import { rates } from "../fx/rates.ts";
import { toHome } from "../fx/index.ts";
import { ledger } from "../ledger/index.ts";
import { sealPiiWith, userDek } from "../privacy/keys.ts";
import { categorize } from "./categorize.ts";
import { dedupeKey } from "./dedupe.ts";
import { normalizeMerchant } from "./normalize.ts";
import { placeFrom } from "./place.ts";
import { pickCard, placeNameAmong, rememberedCategories } from "./service.ts";

/*
 * Statement import, one chunk at a time (POST /import/commit). It writes exactly what `ingestCapture` (notify, Reader
 * category and dedupe off) followed by `reconcileSettlement` (notify and profile off) wrote for each row, in a handful
 * of queries instead of ~25 a row: the user, cards, payees, remembered categories and DEK are read once, every row is
 * worked out in code (rates are warmed by the caller), and then one transaction inserts all rows and appends their
 * ledger entries under one lock (`ledger.appendMany`, the same hash chain). I6: this only logs spending, it never pays.
 * The chunk is all-or-nothing; a retry is safe, because the caller's dedupe counts the rows already written.
 */

export type ImportBatchResult = {
  imported: number;
  failed: number;
  /** (card, purchase currency, settled currency) of each settled row with a card: the fee profiles to refresh. */
  settledPairs: [cardId: string, from: string, to: string][];
};

type Settlement = { settledAmountMinor: number; settledCurrency: string; feeHomeMinor: number; markupBps: number; midRate: string; rateDate: string };

export async function importTransactions(
  userId: string,
  rows: readonly ImportTransaction[],
  db: DbOrTx = getDb(),
  /** The user, when the caller has already read it. */
  user?: { homeCurrency: string },
): Promise<ImportBatchResult> {
  const result: ImportBatchResult = { imported: 0, failed: 0, settledPairs: [] };
  if (rows.length === 0) return result;
  const [u, mine, ownPayees, remembered, dek] = await Promise.all([
    user ?? db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)).then((r) => r[0]),
    db.select().from(cards).where(eq(cards.userId, userId)),
    db.select({ name: payees.name }).from(payees).where(eq(payees.userId, userId)),
    rememberedCategories(db, userId),
    userDek(userId, db),
  ]);
  if (!u) throw new Error("user not found");
  const home = u.homeCurrency;
  const now = clock.now();

  const values: (typeof transactions.$inferInsert)[] = [];
  const entries: { type: string; payload: unknown }[] = [];
  for (const t of rows) {
    let row: typeof transactions.$inferInsert;
    let guessed: string;
    try {
      const merchantRaw = t.merchant;
      const merchantNorm = normalizeMerchant(merchantRaw) || "unknown";
      const occurredAt = new Date(t.occurredAt);
      const card = pickCard(mine, t.cardLast4);
      const fields = { userId, amountMinor: t.amountMinor, currency: t.currency, merchantNorm, occurredAt };
      const h = await toHome(t.amountMinor, t.currency, home, occurredAt);
      const cat = await categorize({ merchantNorm, merchantRaw, mcc: t.mcc, userCategory: remembered.get(merchantNorm) ?? null });
      guessed = cat.category;
      const place = placeFrom(undefined, undefined, placeNameAmong(merchantNorm, merchantRaw, ownPayees));
      const foreign = card ? card.billingCurrency !== t.currency : t.currency !== home;
      row = {
        id: randomUUID(),
        userId,
        source: "IMPORT",
        occurredAt,
        merchantRaw,
        merchantNorm,
        mcc: cat.mcc,
        amountMinor: t.amountMinor,
        currency: t.currency,
        cardId: card?.id ?? null,
        homeAmountMinor: h.amountMinor,
        rateUsed: Number(h.rate),
        rateDate: h.rateDate,
        // The file's own category wins over the guess (without teaching the merchant memory).
        category: t.category || cat.category,
        dedupeKey: dedupeKey(fields),
        mergedIntoId: null,
        status: foreign ? "PENDING" : "SETTLED",
        place,
        createdAt: now,
      };
    } catch {
      // e.g. no exchange rate for the currency on that date
      result.failed++;
      continue;
    }
    // What the account really paid: settled at once (a settlement whose rate is missing leaves the row as it is).
    let settled: Settlement | null = null;
    if (t.settledAmountMinor && t.settledCurrency && t.settledCurrency !== t.currency) {
      settled = await settle(t.amountMinor, t.currency, t.settledAmountMinor, t.settledCurrency, home, isoDate(row.occurredAt)).catch(() => null);
    }
    if (settled) Object.assign(row, { settledAmountMinor: settled.settledAmountMinor, settledCurrency: settled.settledCurrency, feeHomeMinor: settled.feeHomeMinor, status: "SETTLED" });
    values.push(row);
    entries.push({
      type: "CAPTURE_LOGGED",
      payload: {
        userId,
        transactionId: row.id,
        mergedIntoId: null,
        source: "IMPORT",
        parsedBy: "FIELDS",
        amountMinor: t.amountMinor,
        currency: t.currency,
        // As the live path logs it: the category capture guessed, before the file's own one replaced it.
        category: guessed,
        // Merchant text is personal: sealed per entry with the user's key (crypto-shredding still works).
        ...sealPiiWith(dek, userId, { merchantNorm: row.merchantNorm }),
      },
    });
    if (settled) {
      entries.push({
        type: "SETTLEMENT_RECONCILED",
        payload: {
          userId,
          transactionId: row.id,
          settledAmountMinor: settled.settledAmountMinor,
          settledCurrency: settled.settledCurrency,
          feeHomeMinor: settled.feeHomeMinor,
          markupBps: settled.markupBps,
          midRate: settled.midRate,
          rateDate: settled.rateDate,
          dccOverMidBps: null,
        },
      });
      if (row.cardId) result.settledPairs.push([row.cardId, t.currency, settled.settledCurrency]);
    }
  }
  if (values.length === 0) return result;

  await db.transaction(async (tx) => {
    for (let i = 0; i < values.length; i += 500) await tx.insert(transactions).values(values.slice(i, i + 500));
    await ledger.appendMany(entries, tx);
  });
  result.imported = values.length;
  return result;
}

/** `reconcileSettlement`'s fee x-ray for one row, from the (warmed) rates, without reading or writing anything. */
async function settle(amountMinor: number, currency: string, settledAmountMinor: number, settledCurrency: string, home: string, purchaseDate: string): Promise<Settlement> {
  const svc = rates();
  const midOrig = await svc.getRate(currency, home, purchaseDate);
  const midSettled = settledCurrency === home ? undefined : (await svc.getRate(settledCurrency, home, purchaseDate)).rate;
  const fee = settlementFee({
    amountOriginalMinor: amountMinor,
    originalCurrency: currency,
    settledAmountMinor,
    settledCurrency,
    homeCurrency: home,
    midOrigToHome: midOrig.rate,
    ...(midSettled ? { midSettledToHome: midSettled } : {}),
  });
  return { settledAmountMinor, settledCurrency, feeHomeMinor: fee.feeHomeMinor, markupBps: fee.markupBps, midRate: midOrig.rateString, rateDate: midOrig.rateDate };
}
