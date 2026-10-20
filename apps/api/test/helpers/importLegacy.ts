/*
 * The per-row import commit as it was before the batched path (commit 77a8bf9, dataport/service.ts commitImport):
 * every row through the live ingestCapture + reconcileSettlement. Kept only as the golden reference the batched
 * commit is compared with (test/dataport/import-batch.test.ts).
 */
import { type ImportCommitResponse, type ImportHistory, type ImportItems } from "@kassa/shared";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../src/db/client.ts";
import { cards, profiles, transactions, users } from "../../src/db/schema.ts";
import { HttpProblem } from "../../src/http/problem.ts";
import { dedupeCandidates } from "../../src/modules/capture/dedupe.ts";
import { normalizeMerchant } from "../../src/modules/capture/normalize.ts";
import { ingestCapture, reconcileSettlement, refreshCardProfile } from "../../src/modules/capture/service.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { rates } from "../../src/modules/fx/rates.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { addBills } from "../../src/modules/onboarding/service.ts";

/** Rate sources answer one day at a time (~1–3 s each): fetch a chunk's days at once, not one per row while capturing. */
async function warmRates(items: ImportItems, homeCurrency: string): Promise<void> {
  const pairs = new Set<string>();
  for (const t of items.transactions) {
    const day = t.occurredAt.slice(0, 10);
    for (const c of [t.currency, t.settledCurrency]) if (c && c !== homeCurrency) pairs.add(`${c}|${day}`);
  }
  const todo = [...pairs];
  const worker = async () => {
    for (let p = todo.pop(); p; p = todo.pop()) {
      const [c, day] = p.split("|") as [string, string];
      await rates().getRate(c, homeCurrency, day).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
}

async function account(userId: string) {
  const u = (await getDb().select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  // GDPR Art. 18: a restricted account is not processed further.
  if (u.restrictedAt) throw new HttpProblem(403, "ACCOUNT_RESTRICTED", "Processing is restricted for this account");
  return u;
}

/** Adds the import's cards, bills and spending (see the header comment). */
export async function legacyCommitImport(userId: string, items: ImportItems, history?: ImportHistory | null): Promise<ImportCommitResponse> {
  const db = getDb();
  const user = await account(userId);
  const result: ImportCommitResponse = { transactions: { imported: 0, duplicates: 0, failed: 0 }, bills: { added: 0, skipped: 0 }, cards: { added: 0, skipped: 0 }, incomes: { added: 0, skipped: 0 } };

  // Cards first, so imported spending can match them by last 4 digits.
  const existing = await db.select({ label: cards.label, last4: cards.last4 }).from(cards).where(eq(cards.userId, userId));
  for (const c of items.cards) {
    // The same last 4 digits is the same card (whatever its name), as in onboarding.
    if (existing.some((e) => e.last4 === c.last4)) {
      result.cards.skipped++;
      continue;
    }
    await db.insert(cards).values({ userId, ...c });
    existing.push(c);
    result.cards.added++;
  }

  // Incomes: added to the profile unless one with the same source and currency is there already.
  if (items.incomes.length) {
    const profile = (await db.select({ incomes: profiles.incomes }).from(profiles).where(eq(profiles.userId, userId)))[0];
    if (profile) {
      const incomes = [...profile.incomes];
      for (const i of items.incomes) {
        if (incomes.some((x) => x.source.toLowerCase() === i.source.toLowerCase() && x.currency === i.currency)) {
          result.incomes.skipped++;
          continue;
        }
        incomes.push({ source: i.source, currency: i.currency, amountMinor: i.amountMinor, cadence: i.cadence, nextDate: i.nextDate ?? clock.now().toISOString().slice(0, 10) });
        result.incomes.added++;
      }
      if (result.incomes.added) await db.update(profiles).set({ incomes }).where(eq(profiles.userId, userId));
    }
  }

  if (items.bills.length) result.bills = await db.transaction((tx) => addBills(tx, userId, items.bills, "import"));

  // Duplicates are rows that existed before this import (a statement imported twice, or a purchase already captured
  // from Apple Pay); rows of this import never count as each other's duplicates.
  await warmRates(items, user.homeCurrency);

  // The keys that existed before this import, read once for the whole chunk (not one query per row).
  const candidates = items.transactions.map((t) =>
    dedupeCandidates({ userId, amountMinor: t.amountMinor, currency: t.currency, merchantNorm: normalizeMerchant(t.merchant) || "unknown", occurredAt: new Date(t.occurredAt) }),
  );
  const before = new Set<string>();
  const allKeys = [...new Set(candidates.flat())];
  for (let i = 0; i < allKeys.length; i += 1000) {
    const found = await db
      .select({ key: transactions.dedupeKey })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), inArray(transactions.dedupeKey, allKeys.slice(i, i + 1000))));
    for (const f of found) if (f.key) before.add(f.key);
  }
  const feeProfiles = new Map<string, [string, string, string]>();
  for (const [n, t] of items.transactions.entries()) {
    if (candidates[n]!.some((k) => before.has(k))) {
      result.transactions.duplicates++;
      continue;
    }
    try {
      const r = await ingestCapture(
        userId,
        { source: "IMPORT", fields: { merchant: t.merchant, amountMinor: t.amountMinor, currency: t.currency, occurredAt: t.occurredAt, cardHint: t.cardLast4 ?? undefined, mcc: t.mcc ?? undefined } },
        db,
        { notify: false, aiCategory: false, dedupe: false },
      );
      if (!r.transactionId) {
        result.transactions.failed++;
        continue;
      }
      // The file's own category wins over the guess (without teaching the merchant memory).
      if (t.category) await db.update(transactions).set({ category: t.category }).where(eq(transactions.id, r.transactionId));
      if (t.settledAmountMinor && t.settledCurrency && t.settledCurrency !== t.currency && r.status === "LOGGED") {
        const settled = await reconcileSettlement(userId, { transactionId: r.transactionId, amountMinor: t.amountMinor, currency: t.currency, settledAmountMinor: t.settledAmountMinor, settledCurrency: t.settledCurrency }, db, { notify: false, profile: false }).catch(() => null);
        const cardId = settled ? (await db.select({ cardId: transactions.cardId }).from(transactions).where(eq(transactions.id, r.transactionId)))[0]?.cardId : null;
        if (cardId) feeProfiles.set(`${cardId}|${t.currency}|${t.settledCurrency}`, [cardId, t.currency, t.settledCurrency]);
      }
      result.transactions.imported++;
    } catch {
      // e.g. no exchange rate for the currency on that date
      result.transactions.failed++;
    }
  }

  // Each card's markup profile once per currency pair, after all its samples are in (not once per row).
  for (const [cardId, from, to] of feeProfiles.values()) await refreshCardProfile(db, cardId, from, to);
  // What the statements showed, for the agent (get_money_history). The latest import's analysis replaces the last one.
  if (history) await db.update(profiles).set({ moneyHistory: history }).where(eq(profiles.userId, userId));
  await ledger.append("DATA_IMPORTED", { userId, ...result });
  return result;
}
