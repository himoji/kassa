/*
 * Ledger internals (spec §14, I12). Not importable from agent/** (ESLint, spec §4).
 *
 * Entry hash: hash = base64url(sha256(utf8(prevHash + JCS({seq, ts, type, payload})))), with
 * prevHash of the first entry = GENESIS_HASH (base64url of 32 zero bytes). Every 20th entry gets a
 * checkpoint signed with LEDGER_CHECKPOINT_KEY over JCS({seq, headHash, ts, keyId}).
 */
import { jcs, sha256Base64url } from "@kassa/shared";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { KeyObject } from "node:crypto";

import type { Db, DbOrTx } from "../../db/client.ts";
import { ledgerCheckpoints, ledgerEntries } from "../../db/schema.ts";
import { keyIdOf, publicFromPrivate, signText, verifyText } from "./keys.ts";

export const GENESIS_HASH = "A".repeat(43); // base64url(32 zero bytes) without padding
export const CHECKPOINT_EVERY = 20;
/** Arbitrary constant for pg_advisory_xact_lock: serialises appends so seq/prevHash never fork. */
const LEDGER_LOCK_KEY = 7_302_014;

export function entryHash(prevHash: string, seq: number, ts: string, type: string, payload: unknown): string {
  return sha256Base64url(prevHash + jcs({ seq, ts, type, payload }));
}

export function checkpointMessage(seq: number, headHash: string, ts: string, keyId: string): string {
  return jcs({ seq, headHash, ts, keyId });
}

/** JSON round trip: drops undefined, turns Dates into ISO strings — exactly what jsonb will store. */
export function toJsonValue(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload ?? null));
}

export type AppendedEntry = { seq: number; ts: string; type: string; payload: unknown; prevHash: string; hash: string };

export async function appendInTx(
  tx: DbOrTx,
  now: Date,
  checkpointKey: KeyObject,
  type: string,
  payload: unknown,
): Promise<AppendedEntry> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
  const last = await tx
    .select({ seq: ledgerEntries.seq, hash: ledgerEntries.hash })
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.seq))
    .limit(1);
  const prevHash = last[0]?.hash ?? GENESIS_HASH;
  const seq = (last[0]?.seq ?? 0) + 1;
  const ts = now.toISOString();
  const value = toJsonValue(payload);
  const hash = entryHash(prevHash, seq, ts, type, value);
  await tx.insert(ledgerEntries).values({ seq, ts: now, type, payload: value, prevHash, hash });
  if (seq % CHECKPOINT_EVERY === 0) {
    const keyId = keyIdOf(publicFromPrivate(checkpointKey));
    const sig = signText(checkpointKey, checkpointMessage(seq, hash, ts, keyId));
    await tx.insert(ledgerCheckpoints).values({ seq, headHash: hash, sig, keyId, ts: now });
  }
  return { seq, ts, type, payload: value, prevHash, hash };
}

export type VerifyProblem = { seq: number; problem: string };
export type VerifyReport = {
  ok: boolean;
  entries: number;
  checkpoints: number;
  headHash: string;
  problems: VerifyProblem[];
};

/** Recompute the chain and check every checkpoint signature (scripts/ledger-verify.ts, GET /public/verify). */
export async function verifyChain(db: Db, publicKey: KeyObject): Promise<VerifyReport> {
  const problems: VerifyProblem[] = [];
  const keyId = keyIdOf(publicKey);
  const entries = await db.select().from(ledgerEntries).orderBy(asc(ledgerEntries.seq));
  const hashBySeq = new Map<number, string>();
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) problems.push({ seq: e.seq, problem: `expected seq ${expectedSeq}` });
    if (e.prevHash !== prev) problems.push({ seq: e.seq, problem: "prevHash does not link to previous entry" });
    const recomputed = entryHash(e.prevHash, e.seq, e.ts.toISOString(), e.type, e.payload);
    if (recomputed !== e.hash) problems.push({ seq: e.seq, problem: "hash mismatch (entry altered)" });
    hashBySeq.set(e.seq, e.hash);
    prev = e.hash;
    expectedSeq = e.seq + 1;
  }
  const cps = await db.select().from(ledgerCheckpoints).orderBy(asc(ledgerCheckpoints.seq));
  for (const c of cps) {
    const h = hashBySeq.get(c.seq);
    if (h === undefined) problems.push({ seq: c.seq, problem: "checkpoint for missing entry" });
    else if (h !== c.headHash) problems.push({ seq: c.seq, problem: "checkpoint headHash differs from entry hash" });
    if (c.keyId !== keyId) problems.push({ seq: c.seq, problem: `checkpoint keyId ${c.keyId} is not the configured key` });
    else if (!verifyText(publicKey, checkpointMessage(c.seq, c.headHash, c.ts.toISOString(), c.keyId), c.sig)) {
      problems.push({ seq: c.seq, problem: "checkpoint signature invalid" });
    }
  }
  const expectedCheckpoints = Math.floor(entries.length / CHECKPOINT_EVERY);
  if (cps.length < expectedCheckpoints) {
    problems.push({ seq: 0, problem: `expected ${expectedCheckpoints} checkpoints, found ${cps.length}` });
  }
  return { ok: problems.length === 0, entries: entries.length, checkpoints: cps.length, headHash: prev, problems };
}

export async function entryBySeq(db: Db, seq: number) {
  const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.seq, seq));
  return rows[0] ?? null;
}
