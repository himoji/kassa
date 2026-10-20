/*
 * ledger appendMany (data import): the same entries, checkpoints and signed head as one appendInTx per entry at the
 * same `now`, built both ways on two fresh databases and compared row by row; both chains verify.
 */
import { generateKeyPairSync } from "node:crypto";
import { asc } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createPgliteDb, type Db } from "../../src/db/client.ts";
import { ledgerCheckpoints, ledgerEntries, ledgerHead } from "../../src/db/schema.ts";
import { appendInTx, appendManyInTx, verifyChain } from "../../src/modules/ledger/internal.ts";
import { publicFromPrivate } from "../../src/modules/ledger/keys.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const pub = publicFromPrivate(privateKey);
const now = new Date("2026-10-20T09:30:00.000Z");
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

async function fresh(): Promise<Db> {
  const { db, close } = await createPgliteDb();
  closers.push(close);
  return db;
}

async function dump(db: Db) {
  return {
    entries: await db.select().from(ledgerEntries).orderBy(asc(ledgerEntries.seq)),
    checkpoints: await db.select().from(ledgerCheckpoints).orderBy(asc(ledgerCheckpoints.seq)),
    head: await db.select().from(ledgerHead),
  };
}

const batch = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: i % 3 === 2 ? "SETTLEMENT_RECONCILED" : "CAPTURE_LOGGED", payload: { userId: "u-1", i: from + i, skip: undefined, at: now } }));

describe("ledger appendMany", () => {
  it("writes the same chain, checkpoints and head as one append per entry, on top of an existing chain", async () => {
    const single = await fresh();
    const many = await fresh();
    // An existing chain of 7 entries, then 45 more: checkpoints fall at 20 and 40 inside the batch.
    const before = batch(0, 7);
    const entries = batch(7, 45);
    for (const db of [single, many]) for (const e of before) await db.transaction((tx) => appendInTx(tx, now, privateKey, e.type, e.payload));
    for (const e of entries) await single.transaction((tx) => appendInTx(tx, now, privateKey, e.type, e.payload));
    const out = await many.transaction((tx) => appendManyInTx(tx, now, privateKey, entries));

    expect(out.map((e) => e.seq)).toEqual(Array.from({ length: 45 }, (_, i) => 8 + i));
    const a = await dump(single);
    const b = await dump(many);
    expect(b.entries).toEqual(a.entries);
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(b.checkpoints.map((c) => c.seq)).toEqual([20, 40]);
    expect(b.head).toEqual(a.head);
    expect(b.head[0]?.seq).toBe(52);
    for (const db of [single, many]) expect(await verifyChain(db, pub)).toMatchObject({ ok: true, entries: 52, checkpoints: 2, headAnchorSeq: 52 });
  });

  it("starts from the genesis hash on an empty ledger, and an empty batch writes nothing", async () => {
    const single = await fresh();
    const many = await fresh();
    expect(await many.transaction((tx) => appendManyInTx(tx, now, privateKey, []))).toEqual([]);
    expect((await dump(many)).head).toEqual([]);
    const entries = batch(0, 20);
    for (const e of entries) await single.transaction((tx) => appendInTx(tx, now, privateKey, e.type, e.payload));
    await many.transaction((tx) => appendManyInTx(tx, now, privateKey, entries));
    expect(await dump(many)).toEqual(await dump(single));
    expect(await verifyChain(many, pub)).toMatchObject({ ok: true, entries: 20, checkpoints: 1 });
  });
});
