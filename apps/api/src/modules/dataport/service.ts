import { type ImportCommitResponse, type ImportHistory, type ImportItems, type KassaExport } from "@kassa/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { budgets, cards, obligations, payees, profiles, transactions, users } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { dedupeCandidates } from "../capture/dedupe.ts";
import { normalizeMerchant } from "../capture/normalize.ts";
import { importTransactions } from "../capture/importBatch.ts";
import { refreshCardProfile } from "../capture/service.ts";
import { clock } from "../clock/index.ts";
import { rates } from "../fx/rates.ts";
import { ledger } from "../ledger/index.ts";
import { addBills } from "../onboarding/service.ts";

/*
 * Data export / import (GET /export, POST /import/commit; the preview is mapper.ts).
 * Import only ever ADDS records that loosen nothing: spending history goes through capture (I6: capture only logs,
 * with its dedupe, categories and FX), bills through the onboarding path (placeholder payees without an account,
 * never payable until verified; sanctions screening, I9), cards are labels, incomes join the profile (the forecast
 * reads them; they loosen nothing). A purchase abroad with the amount the account really paid is settled at once, so
 * the fee x-ray and the card's markup profile learn from the history (no notification per row). Budgets are not
 * written here: raising one loosens the rules, so the app applies them with PUT /budgets and the passkey.
 */

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

/** Kassa's portable export (kassa-export v1). */
export async function exportData(userId: string): Promise<KassaExport> {
  const db = getDb();
  const u = await account(userId);
  const profile = (await db.select({ incomes: profiles.incomes }).from(profiles).where(eq(profiles.userId, userId)))[0];
  const cardRows = await db.select().from(cards).where(eq(cards.userId, userId));
  const last4 = new Map(cardRows.map((c) => [c.id, c.last4]));
  // The latest limit per category.
  const budgetRows = await db.select().from(budgets).where(eq(budgets.userId, userId)).orderBy(desc(budgets.periodStart));
  const latest = [...new Map(budgetRows.reverse().map((b) => [b.category, b])).values()];
  const bills = await db
    .select({ name: payees.name, kind: payees.kind, amountMinor: obligations.amountMinor, currency: obligations.currency, dueDate: obligations.dueDate, recurrence: obligations.recurrence, category: obligations.category })
    .from(obligations)
    .innerJoin(payees, eq(payees.id, obligations.payeeId))
    .where(eq(obligations.userId, userId));
  const tx = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.mergedIntoId)))
    .orderBy(desc(transactions.occurredAt));
  return {
    format: "kassa-export",
    version: 1,
    exportedAt: clock.now().toISOString(),
    profile: {
      displayName: u.displayName,
      homeCurrency: u.homeCurrency,
      region: u.region,
      incomes: (profile?.incomes ?? []).map((i) => ({ source: i.source, currency: i.currency, amountMinor: i.amountMinor, cadence: i.cadence, nextDate: i.nextDate ?? null })),
    },
    cards: cardRows.map((c) => ({ label: c.label, last4: c.last4, billingCurrency: c.billingCurrency, kind: c.kind })),
    budgets: latest.map((b) => ({ category: b.category, limitHomeMinor: b.limitHomeMinor, periodStart: b.periodStart })),
    bills: bills.map((b) => ({ payeeName: b.name, payeeKind: b.kind, amountMinor: b.amountMinor, currency: b.currency, dueDate: b.dueDate, recurrence: b.recurrence, category: b.category ?? "bills" })),
    transactions: tx
      .filter((t) => t.amountMinor > 0)
      .map((t) => ({
        occurredAt: t.occurredAt.toISOString(),
        merchant: t.merchantRaw.slice(0, 140) || "Unknown merchant",
        amountMinor: t.amountMinor,
        currency: t.currency,
        category: t.category,
        cardLast4: t.cardId ? (last4.get(t.cardId) ?? null) : null,
        mcc: t.mcc && /^\d{4}$/.test(t.mcc) ? t.mcc : null,
      })),
  };
}

/** Adds the import's cards, bills and spending (see the header comment). */
export async function commitImport(userId: string, items: ImportItems, history?: ImportHistory | null): Promise<ImportCommitResponse> {
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
  const fresh = items.transactions.filter((_, n) => !candidates[n]!.some((k) => before.has(k)));
  result.transactions.duplicates = items.transactions.length - fresh.length;
  // The chunk's spending in one transaction (capture/importBatch.ts): the same rows and ledger entries as capturing
  // and settling each row on its own, in a handful of queries instead of ~25 a row.
  const batch = await importTransactions(userId, fresh, db, user);
  result.transactions.imported = batch.imported;
  result.transactions.failed = batch.failed;
  const feeProfiles = new Map(batch.settledPairs.map((p) => [p.join("|"), p] as const));

  // Each card's markup profile once per currency pair, after all its samples are in (not once per row).
  for (const [cardId, from, to] of feeProfiles.values()) await refreshCardProfile(db, cardId, from, to);
  // What the statements showed, for the agent (get_money_history). The latest import's analysis replaces the last one.
  if (history) await db.update(profiles).set({ moneyHistory: history }).where(eq(profiles.userId, userId));
  await ledger.append("DATA_IMPORTED", { userId, ...result });
  return result;
}
