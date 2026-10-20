/*
 * Batched import commit (capture/importBatch.ts, docs/architecture/import-batch-commit-plan.md).
 * - Golden: the same synthetic statement committed through the old per-row path (test/helpers/importLegacy.ts) and
 *   through the batched one, on two fresh databases, writes the same transaction rows, ledger entries (types,
 *   payloads, sealed merchant text), card fee profiles and response counts; both ledgers verify.
 * - Query count: a 50-row chunk is a handful of statements, not ~25 a row.
 * All data here is fictitious.
 */
import { PGlite } from "@electric-sql/pglite";
import type { ImportItems, ImportTransaction } from "@kassa/shared";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, MIGRATIONS_DIR, schema, setDb, type Db } from "../../src/db/client.ts";
import { cardFeeProfiles, cards, ledgerEntries, payees, transactions, users } from "../../src/db/schema.ts";
import { merchantCategoryMemory } from "../../src/db/schema.intel.ts";
import { importTransactions } from "../../src/modules/capture/importBatch.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { commitImport } from "../../src/modules/dataport/service.ts";
import { checkpointPublicKey } from "../../src/modules/ledger/index.ts";
import { verifyChain } from "../../src/modules/ledger/internal.ts";
import { clearDekCache, openPii } from "../../src/modules/privacy/keys.ts";
import { createUser } from "../../src/modules/users/service.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { legacyCommitImport } from "../helpers/importLegacy.ts";

const USER = "0b5e2c1a-7d3f-4e8a-9c21-5a6f0e4d3b21";
const NOW = new Date("2026-10-20T12:00:00.000Z");

/** A fresh in-memory database whose statements are counted (drizzle's logger sees every statement it sends). */
async function countedDb(): Promise<{ db: Db; count: () => number; close: () => Promise<void> }> {
  const client = new PGlite();
  let n = 0;
  const pg = drizzle(client, { schema, logger: { logQuery: () => void n++ } });
  await migrate(pg, { migrationsFolder: MIGRATIONS_DIR });
  const db = pg as unknown as Db;
  return { db, count: () => n, close: () => client.close() };
}

/** Same user, card, payee and remembered category in every database. */
async function seed(db: Db) {
  setDb(db);
  clearDekCache();
  await createUser(db, { id: USER, displayName: "Test Student", homeCurrency: "EUR" });
  await db.insert(payees).values({ userId: USER, name: "Studio Lumen", kind: "MERCHANT", country: "DE", currency: "EUR" });
  await db.insert(merchantCategoryMemory).values({ userId: USER, merchantNorm: "corner kiosk", category: "transport", updatedAt: NOW });
}

const day = (d: number, h: number) => `2026-09-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:15:00.000Z`;
const tx = (o: Partial<ImportTransaction> & Pick<ImportTransaction, "occurredAt" | "merchant" | "amountMinor" | "currency">): ImportTransaction => ({
  category: null,
  cardLast4: null,
  mcc: null,
  ...o,
});

/** Every case the live path handles differently, over several days (60+ rows, so checkpoints fall inside a chunk). */
function statement(): ImportItems {
  const rows: ImportTransaction[] = [];
  for (let d = 1; d <= 6; d++) {
    rows.push(
      tx({ occurredAt: day(d, 8), merchant: "REWE Markt", amountMinor: 1200 + d, currency: "EUR" }), // keyword category
      tx({ occurredAt: day(d, 9), merchant: "Morning Bakery", amountMinor: 350 + d, currency: "EUR" }), // dictionary
      tx({ occurredAt: day(d, 10), merchant: "SQ *BLUE BOTTLE", amountMinor: 480 + d, currency: "EUR" }), // processor
      tx({ occurredAt: day(d, 11), merchant: "STUDIO LUMEN", amountMinor: 2500 + d, currency: "EUR", category: "rent" }), // payee, file category
      tx({ occurredAt: day(d, 12), merchant: "Corner Kiosk", amountMinor: 220 + d, currency: "EUR", mcc: "5812" }), // remembered
      tx({ occurredAt: day(d, 13), merchant: "Airline Desk", amountMinor: 9900 + d, currency: "USD", cardLast4: "4821" }), // card in its currency
      tx({ occurredAt: day(d, 14), merchant: "Lawson", amountMinor: 3200 + d, currency: "JPY" }), // foreign, pending
      tx({ occurredAt: day(d, 15), merchant: "Lawson", amountMinor: 1800 + d, currency: "JPY", settledAmountMinor: 1150 + d, settledCurrency: "EUR" }), // settled, no card
      tx({ occurredAt: day(d, 16), merchant: "Book Store", amountMinor: 2000 + d, currency: "USD", cardLast4: "4821", settledAmountMinor: 1900 + d, settledCurrency: "EUR" }), // settled, card
      tx({ occurredAt: day(d, 17), merchant: "Odd Coin", amountMinor: 100 + d, currency: "ZZZ" }), // no rate: failed
      tx({ occurredAt: day(d, 18), merchant: "Odd Settle", amountMinor: 700 + d, currency: "USD", settledAmountMinor: 650 + d, settledCurrency: "ZZZ" }), // settlement fails: kept unsettled
    );
  }
  return { transactions: rows, bills: [], cards: [{ label: "Travel card", last4: "4821", billingCurrency: "USD", kind: "USD" }], budgets: [], incomes: [] };
}

/** Everything an import wrote, with random ids replaced by stable keys and sealed text opened. */
async function snapshot(db: Db) {
  setDb(db);
  clearDekCache();
  const last4 = new Map((await db.select().from(cards)).map((c) => [c.id, c.last4]));
  const rows = (await db.select().from(transactions).where(eq(transactions.userId, USER))).map(({ id, cardId, ...r }) => ({ id, row: { ...r, card: cardId ? last4.get(cardId) : null } }));
  rows.sort((a, b) => (a.row.dedupeKey! < b.row.dedupeKey! ? -1 : 1));
  const key = new Map(rows.map((r) => [r.id, r.row.dedupeKey]));
  const entries = [];
  for (const e of await db.select().from(ledgerEntries).orderBy(asc(ledgerEntries.seq))) {
    const p = { ...(e.payload as Record<string, unknown>) };
    if (typeof p.transactionId === "string") p.transactionId = key.get(p.transactionId);
    if (typeof p.pii === "string") p.pii = await openPii(USER, p.pii, db);
    entries.push({ seq: e.seq, ts: e.ts, type: e.type, payload: p });
  }
  const profiles = (await db.select().from(cardFeeProfiles)).map(({ cardId, ...p }) => ({ ...p, card: last4.get(cardId) }));
  return { rows: rows.map((r) => r.row), entries, profiles, verify: await verifyChain(db, checkpointPublicKey()) };
}

const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  offlineEnvironment();
  clock.freezeForTests(NOW);
  clock.setOffsetInMemoryForTests(0);
});
afterEach(() => {
  clock.freezeForTests(null);
});
afterAll(async () => {
  for (const c of closers) await c();
  await closeDb();
});

describe("batched import commit", () => {
  it("writes the same rows and ledger entries as the per-row path (golden)", async () => {
    const legacy = await countedDb();
    const batched = await countedDb();
    closers.push(legacy.close, batched.close);
    const items = statement();

    await seed(legacy.db);
    const l1 = await legacyCommitImport(USER, items);
    const l2 = await legacyCommitImport(USER, items); // a second import of the same file: all duplicates
    await seed(batched.db);
    const b1 = await commitImport(USER, items);
    const b2 = await commitImport(USER, items);

    expect(b1).toEqual(l1);
    expect(b2).toEqual(l2);
    expect(b1.transactions).toEqual({ imported: 60, duplicates: 0, failed: 6 });
    expect(b2.transactions).toEqual({ imported: 0, duplicates: 60, failed: 6 });

    const a = await snapshot(legacy.db);
    const b = await snapshot(batched.db);
    expect(b.rows).toEqual(a.rows);
    expect(b.entries).toEqual(a.entries);
    expect(b.profiles).toEqual(a.profiles);
    expect(a.verify).toMatchObject({ ok: true, problems: [] });
    expect(b.verify).toMatchObject({ ok: true, problems: [], entries: a.verify.entries, checkpoints: a.verify.checkpoints });

    // The fixture exercised what it claims to: settled rows (with and without a card), pending ones, failed rate.
    expect(b.rows.filter((r) => r.feeHomeMinor !== null)).toHaveLength(12);
    expect(b.rows.filter((r) => r.status === "PENDING").map((r) => r.merchantRaw)).toEqual(expect.arrayContaining(["Lawson", "Odd Settle"]));
    expect(b.entries.filter((e) => e.type === "SETTLEMENT_RECONCILED")).toHaveLength(12);
    expect(b.entries.find((e) => e.type === "CAPTURE_LOGGED")?.payload.pii).toEqual({ merchantNorm: expect.any(String) });
    expect(b.profiles).toEqual([expect.objectContaining({ card: "4821", fromCurrency: "USD", toCurrency: "EUR", samples: 6 })]);
    expect(a.verify.checkpoints).toBeGreaterThanOrEqual(3);
  });

  it("a 50-row chunk takes a handful of statements (the per-row path took ~10 a row)", async () => {
    const legacy = await countedDb();
    const batched = await countedDb();
    closers.push(legacy.close, batched.close);
    const items = statement();
    const warm = { ...items, transactions: items.transactions.slice(0, 2) };
    const chunk = items.transactions.slice(2).filter((t) => t.currency !== "ZZZ").slice(0, 50);
    expect(chunk).toHaveLength(50);

    // Cards, rates and the user's key exist before the measured chunk, as they do from an import's second chunk on.
    await seed(legacy.db);
    await legacyCommitImport(USER, warm);
    await seed(batched.db);
    await commitImport(USER, warm);

    setDb(legacy.db);
    let before = legacy.count();
    await legacyCommitImport(USER, { ...items, cards: [], transactions: chunk });
    const legacyStatements = legacy.count() - before;

    setDb(batched.db);
    const u = (await batched.db.select().from(users).where(eq(users.id, USER)))[0]!;
    before = batched.count();
    const r = await importTransactions(USER, chunk, batched.db, u); // as commitImport calls it, with the user it read
    const batchStatements = batched.count() - before;
    before = batched.count();
    await commitImport(USER, { ...items, cards: [], transactions: chunk.map((t) => ({ ...t, amountMinor: t.amountMinor + 1 })) });
    const commitStatements = batched.count() - before;

    console.info(`50-row chunk: per-row path ${legacyStatements} statements; importTransactions ${batchStatements}; whole commitImport ${commitStatements} (BEGIN/COMMIT not counted)`);
    expect(r).toMatchObject({ imported: 50, failed: 0 });
    // cards, payees, remembered categories (read together), one insert, then lock, head, entries, checkpoints, head.
    expect(batchStatements).toBeLessThan(10);
    expect(commitStatements).toBeLessThanOrEqual(20);
    expect(legacyStatements).toBeGreaterThan(400);
  });
});
