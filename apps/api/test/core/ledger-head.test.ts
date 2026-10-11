/*
 * X6 (security review F5): entries after the last signed checkpoint could be truncated, or altered and re-hashed,
 * without `ledger:verify` noticing. Every append now also persists a signed head anchor (seq, hash) in the same
 * transaction (Ed25519, LEDGER_CHECKPOINT_KEY, domain-separated from checkpoint signatures); verify checks that the
 * anchor exists, is validly signed, and names the actual last entry.
 */
import { eq, gt } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerCheckpoints, ledgerEntries, ledgerHead } from "../../src/db/schema.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { entryHash } from "../../src/modules/ledger/internal.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

async function append(n: number) {
  for (let i = 0; i < n; i++) await ledger.append("E", { userId: "u", i });
}

/** Attacker with DB write access but without the checkpoint key: rewrite entry `seq` and re-hash the chain after it. */
async function rehashFrom(seq: number, payload: unknown) {
  const db = getDb();
  const rows = (await db.select().from(ledgerEntries)).sort((a, b) => a.seq - b.seq);
  let prev = rows.find((r) => r.seq === seq - 1)!.hash;
  for (const r of rows.filter((x) => x.seq >= seq)) {
    const p = r.seq === seq ? payload : r.payload;
    const hash = entryHash(prev, r.seq, r.ts.toISOString(), r.type, p);
    await db.update(ledgerEntries).set({ payload: p, prevHash: prev, hash }).where(eq(ledgerEntries.seq, r.seq));
    prev = hash;
  }
}

describe("X6 ledger head anchor", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("every append moves the signed head; a clean ledger verifies", async () => {
    await append(25);
    const head = (await getDb().select().from(ledgerHead))[0]!;
    const last = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.seq, 25)))[0]!;
    expect(head).toMatchObject({ seq: 25, headHash: last.hash });
    expect(await ledger.verify()).toMatchObject({ ok: true, entries: 25, checkpoints: 1 });
  });

  it("detects tail truncation after the last checkpoint", async () => {
    await append(25); // checkpoint at 20
    await getDb().delete(ledgerEntries).where(gt(ledgerEntries.seq, 20));
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.problem).join(" | ")).toMatch(/head anchor/);
  });

  it("detects an altered and re-hashed tail after the last checkpoint", async () => {
    await append(25);
    await rehashFrom(23, { userId: "u", i: 999 });
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /head anchor/.test(p.problem))).toBe(true);
  });

  it("detects truncation of a ledger shorter than one checkpoint interval", async () => {
    await append(5);
    await getDb().delete(ledgerEntries).where(gt(ledgerEntries.seq, 3));
    expect((await ledger.verify()).ok).toBe(false);
  });

  it("a deleted head anchor is a problem when entries exist", async () => {
    await append(3);
    await getDb().delete(ledgerHead);
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /head anchor missing/.test(p.problem))).toBe(true);
  });

  it("a head moved to the truncated tail without the key fails its signature (incl. reusing a checkpoint signature)", async () => {
    await append(25);
    await getDb().delete(ledgerEntries).where(gt(ledgerEntries.seq, 20));
    const cp = (await getDb().select().from(ledgerCheckpoints).where(eq(ledgerCheckpoints.seq, 20)))[0]!;
    // Re-point the head at entry 20 using the checkpoint's own (valid, but checkpoint-domain) signature.
    await getDb().update(ledgerHead).set({ seq: 20, headHash: cp.headHash, sig: cp.sig, keyId: cp.keyId, ts: cp.ts });
    const report = await ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /head anchor signature invalid/.test(p.problem))).toBe(true);
  });
});
