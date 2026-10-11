/* Ledger hash chain + signed checkpoints (spec §14, I12). */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerCheckpoints, ledgerEntries } from "../../src/db/schema.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { CHECKPOINT_EVERY, entryHash, GENESIS_HASH } from "../../src/modules/ledger/internal.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

describe("ledger", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("chains entries from the genesis hash", async () => {
    const a = await ledger.append("A", { userId: "u", n: 1 });
    const b = await ledger.append("B", { userId: "u", n: 2, skip: undefined });
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(b.payload).toEqual({ userId: "u", n: 2 }); // undefined dropped before hashing (JSON semantics)
    expect(a.hash).toBe(entryHash(GENESIS_HASH, 1, a.ts, "A", { userId: "u", n: 1 }));
    expect((await ledger.verify()).ok).toBe(true);
  });

  it(`writes a signed checkpoint every ${CHECKPOINT_EVERY} entries`, async () => {
    for (let i = 0; i < 45; i++) await ledger.append("E", { i });
    const cps = await getDb().select().from(ledgerCheckpoints);
    expect(cps.map((c) => c.seq)).toEqual([20, 40]);
    const report = await ledger.verify();
    expect(report).toMatchObject({ ok: true, entries: 45, checkpoints: 2 });
  });

  it("detects an altered payload", async () => {
    for (let i = 0; i < 5; i++) await ledger.append("E", { i });
    await getDb().update(ledgerEntries).set({ payload: { i: 999 } }).where(eq(ledgerEntries.seq, 3));
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.seq === 3 && /hash mismatch/.test(p.problem))).toBe(true);
  });

  it("detects a deleted entry and a recomputed (re-hashed) forgery", async () => {
    for (let i = 0; i < 22; i++) await ledger.append("E", { i });
    // Attacker rewrites entry 5 AND recomputes its hash: the next link and the checkpoint at 20 break.
    const e5 = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.seq, 5)))[0]!;
    const forged = entryHash(e5.prevHash, 5, e5.ts.toISOString(), e5.type, { i: -1 });
    await getDb().update(ledgerEntries).set({ payload: { i: -1 }, hash: forged }).where(eq(ledgerEntries.seq, 5));
    let report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.seq === 6 && /prevHash/.test(p.problem))).toBe(true);
    await t.reset();
    for (let i = 0; i < 3; i++) await ledger.append("E", { i });
    await getDb().delete(ledgerEntries).where(eq(ledgerEntries.seq, 2));
    report = await ledger.verify();
    expect(report.ok).toBe(false);
  });

  it("detects a forged checkpoint signature", async () => {
    for (let i = 0; i < 20; i++) await ledger.append("E", { i });
    await getDb().update(ledgerCheckpoints).set({ sig: "AAAA" }).where(eq(ledgerCheckpoints.seq, 20));
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /signature invalid/.test(p.problem))).toBe(true);
  });

  it("serialises concurrent appends without forking the chain", async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => ledger.append("C", { i })));
    const report = await ledger.verify();
    expect(report).toMatchObject({ ok: true, entries: 15 });
  });

  it("pages a user's entries newest first", async () => {
    for (let i = 0; i < 5; i++) await ledger.append("E", { userId: "u1", i });
    await ledger.append("E", { userId: "u2" });
    const p1 = await ledger.page("u1", null, 3);
    expect(p1.items.map((e) => (e.payload as { i: number }).i)).toEqual([4, 3, 2]);
    const p2 = await ledger.page("u1", Number(p1.nextCursor), 3);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
  });
});
