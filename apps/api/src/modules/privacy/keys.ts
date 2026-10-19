/*
 * Per-user data encryption keys (GDPR Art. 17 erasure by crypto-shredding, Art. 32 encryption).
 *
 * - DEK: 32 random bytes per user, AES-256-GCM (NIST SP 800-38D): 96-bit random IV (§8.2.2), 128-bit tag.
 * - KEK: held by a KeyProvider (R15). The default is the env provider, USER_KEK from env: the DEK is stored wrapped,
 *   AES-256-GCM(KEK, DEK, AAD = "kassa:dek:v1:" + userId), so a wrapped key cannot be moved to another user.
 *   (AES-GCM wrapping instead of RFC 3394 AES-KW: one primitive in the codebase, authenticated, and the AAD binds
 *   the owner.) `user_keys.kek_id` names the KEK of each row. A KMS provider would implement the same interface
 *   (docs/security/self-assessment.md R15); `setKeyProvider` installs it.
 * - Rotation (scripts/rotate-kek.ts, `rewrapUserKeys`): every row is re-wrapped from the old KEK to the new one in
 *   one transaction; DEKs and so every sealed ciphertext stay the same. While USER_KEK_PREVIOUS is set, the env
 *   provider still unwraps rows of the previous KEK, so the API can run on the new KEK before the re-wrap.
 * - Sealed fields: JSON of the personal fields, AES-256-GCM(DEK, AAD = "kassa:pii:v1:" + userId), written as
 *   "v1.<iv>.<ciphertext>.<tag>" (base64url, RFC 4648 §5) into the ledger payload's `pii` member. The hash
 *   chain covers the ciphertext, so shredding the DEK makes the fields unreadable without touching any entry:
 *   `bun run ledger:verify` keeps passing after an erasure.
 * - Shredding nulls `user_keys.wrapped_dek` and keeps the row as a tombstone, so no new key is ever minted for
 *   an erased user (later appends for that user drop their personal fields instead of encrypting them).
 *
 * Honest limits: unwrapped DEKs are cached in process memory (cleared on shred); a database backup taken
 * before the erasure still holds the wrapped DEK — backups must expire within the retention window, and the
 * KEK is never in the database, so a DB-only leak reveals no personal ledger fields.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getDb, type Db, type DbOrTx } from "../../db/client.ts";
import { userKeys } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";

const VERSION = "v1";

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return [VERSION, iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [v, ivB, ctB, tagB] = sealed.split(".");
  if (v !== VERSION || !ivB || ctB === undefined || !tagB) throw new Error("bad sealed value format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]);
}

const dekAad = (userId: string) => `kassa:dek:v1:${userId}`;
const piiAad = (userId: string) => `kassa:pii:v1:${userId}`;

// ---------- key-encryption keys ----------

/** Holds the KEK(s) that wrap per-user DEKs. Never exposes a KEK; async so a remote KMS can implement it. */
export interface KeyProvider {
  /** Public id of the KEK that wraps new keys (stored in user_keys.kek_id). */
  kekId(): string;
  /** Wrap a DEK; the AAD binds it to its owner. */
  wrap(dek: Buffer, aad: string): Promise<string>;
  /** Unwrap a DEK wrapped under `kekId`. Throws for a KEK it does not hold or a value that does not authenticate. */
  unwrap(wrapped: string, aad: string, kekId: string): Promise<Buffer>;
}

function decodeKek(base64: string, name: string): Buffer {
  const k = Buffer.from(base64, "base64");
  if (k.length !== 32) throw new Error(`${name} must be 32 bytes (base64)`);
  return k;
}

/** Short public identifier of a KEK: base64url(sha256(KEK))[0..16]. Not secret. */
function idOf(k: Buffer): string {
  return createHash("sha256").update(k).digest("base64url").slice(0, 16);
}

/**
 * Today's behaviour: the KEK is 32 bytes from env, wrapping is local AES-256-GCM. `previous` (USER_KEK_PREVIOUS) is
 * only ever used to unwrap, during a rotation.
 */
export function envKeyProvider(kekBase64: string, previousBase64?: string, name = "USER_KEK"): KeyProvider {
  const current = decodeKek(kekBase64, name);
  const id = idOf(current);
  const byId = new Map<string, Buffer>([[id, current]]);
  if (previousBase64) {
    const prev = decodeKek(previousBase64, `${name}_PREVIOUS`);
    if (!byId.has(idOf(prev))) byId.set(idOf(prev), prev);
  }
  return {
    kekId: () => id,
    wrap: async (dek, aad) => seal(current, dek, aad),
    unwrap: async (wrapped, aad, kekId) => {
      const k = byId.get(kekId);
      if (!k) throw new Error(`user key is wrapped under KEK ${kekId}, which this provider does not hold (scripts/rotate-kek.ts)`);
      return open(k, wrapped, aad);
    },
  };
}

let installed: KeyProvider | null = null;
let fromEnv: { kek: string; previous: string | undefined; provider: KeyProvider } | null = null;

/** The provider in use: an installed one, else the env provider (rebuilt if the env changes, as in tests). */
export function keyProvider(): KeyProvider {
  if (installed) return installed;
  const { USER_KEK, USER_KEK_PREVIOUS } = env();
  if (!fromEnv || fromEnv.kek !== USER_KEK || fromEnv.previous !== USER_KEK_PREVIOUS) {
    fromEnv = { kek: USER_KEK, previous: USER_KEK_PREVIOUS, provider: envKeyProvider(USER_KEK, USER_KEK_PREVIOUS) };
  }
  return fromEnv.provider;
}

/** Install a provider (a KMS one, or tests); null goes back to the env provider. Clears the DEK cache. */
export function setKeyProvider(p: KeyProvider | null): void {
  installed = p;
  cache.clear();
}

/** Short public identifier of the current KEK (to detect a rotated/mismatched KEK). */
export function kekId(): string {
  return keyProvider().kekId();
}

/** userId → unwrapped DEK, or null when shredded. */
const cache = new Map<string, Buffer | null>();

/** Tests / erasure: forget cached keys. */
export function clearDekCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/**
 * The user's DEK: created on first use; null when the key was shredded (erased user). Pass the caller's
 * transaction when inside one (PGlite has a single connection: a second transaction would wait on it).
 */
export async function userDek(userId: string, db: DbOrTx = getDb()): Promise<Buffer | null> {
  if (cache.has(userId)) return cache.get(userId) ?? null;
  let row = (await db.select().from(userKeys).where(eq(userKeys.userId, userId)))[0];
  if (!row) {
    const dek = randomBytes(32);
    const kp = keyProvider();
    await db
      .insert(userKeys)
      .values({ userId, wrappedDek: await kp.wrap(dek, dekAad(userId)), kekId: kp.kekId(), createdAt: clock.now() })
      .onConflictDoNothing();
    // Re-read: a concurrent creator may have won the insert.
    row = (await db.select().from(userKeys).where(eq(userKeys.userId, userId)))[0];
    if (!row) throw new Error("user key could not be created");
  }
  if (!row.wrappedDek) {
    cache.set(userId, null);
    return null;
  }
  const dek = await keyProvider().unwrap(row.wrappedDek, dekAad(userId), row.kekId);
  cache.set(userId, dek);
  return dek;
}

/** Crypto-shred: the wrapped DEK is deleted; ciphertexts under it become unreadable. Idempotent. */
export async function shredUserKey(userId: string, db: DbOrTx = getDb()): Promise<void> {
  const now = clock.now();
  await db
    .insert(userKeys)
    .values({ userId, wrappedDek: null, kekId: kekId(), createdAt: now, shreddedAt: now })
    .onConflictDoUpdate({ target: userKeys.userId, set: { wrappedDek: null, shreddedAt: now } });
  cache.set(userId, null);
}

export type PiiFields = Record<string, unknown>;

/**
 * Seal personal fields for an append-only store. Returns `{ pii }` to spread into a ledger payload, or
 * `{ piiErased: true }` when the user's key was shredded (the fields are dropped, never written in clear).
 */
export async function sealPii(userId: string, fields: PiiFields, db: DbOrTx = getDb()): Promise<{ pii: string } | { piiErased: true }> {
  const dek = await userDek(userId, db);
  if (!dek) return { piiErased: true };
  return { pii: seal(dek, Buffer.from(JSON.stringify(fields), "utf8"), piiAad(userId)) };
}

/** Decrypt a sealed `pii` value; null when the key is shredded or the value does not authenticate. */
export async function openPii(userId: string, sealed: string, db: DbOrTx = getDb()): Promise<PiiFields | null> {
  const dek = await userDek(userId, db);
  if (!dek) return null;
  try {
    return JSON.parse(open(dek, sealed, piiAad(userId)).toString("utf8")) as PiiFields;
  } catch {
    return null;
  }
}

/**
 * Ledger payload as shown to its owner: `pii` is replaced by the decrypted fields; after erasure the
 * fields are gone and `piiErased: true` is set. Payloads without `pii` are returned unchanged.
 */
export async function viewLedgerPayload(payload: unknown, db: DbOrTx = getDb()): Promise<unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if (typeof p.pii !== "string" || typeof p.userId !== "string") return payload;
  const { pii, ...rest } = p;
  const fields = await openPii(p.userId, pii as string, db);
  return fields ? { ...rest, ...fields } : { ...rest, piiErased: true };
}

export type RewrapReport = { total: number; rewrapped: number; alreadyCurrent: number; shredded: number; fromKekId: string; toKekId: string; dryRun: boolean };

/**
 * KEK rotation (R15): re-wrap every user_keys row from `from` to `to` inside one transaction, under an EXCLUSIVE
 * table lock (reads go on; a key created meanwhile waits and is then wrapped by the API's own provider). Rows already
 * under `to` are skipped, so a re-run is safe; shredded rows stay shredded. A row under any other KEK aborts the
 * whole rotation. Each new wrap is unwrapped again and compared before it is written. `dryRun` does all of it and
 * writes nothing. Returns counts only, never key material.
 */
export async function rewrapUserKeys(from: KeyProvider, to: KeyProvider, opts: { dryRun?: boolean } = {}, db: Db = getDb()): Promise<RewrapReport> {
  const fromKekId = from.kekId();
  const toKekId = to.kekId();
  if (fromKekId === toKekId) throw new Error("the old and the new KEK are the same");
  const report: RewrapReport = { total: 0, rewrapped: 0, alreadyCurrent: 0, shredded: 0, fromKekId, toKekId, dryRun: opts.dryRun === true };
  await db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${userKeys} in exclusive mode`);
    const rows = await tx.select().from(userKeys).orderBy(userKeys.userId);
    report.total = rows.length;
    for (const row of rows) {
      if (!row.wrappedDek) {
        report.shredded++;
        continue;
      }
      if (row.kekId === toKekId) {
        report.alreadyCurrent++;
        continue;
      }
      if (row.kekId !== fromKekId) throw new Error(`a user key is wrapped under KEK ${row.kekId}, neither the old nor the new one: nothing was changed`);
      const aad = dekAad(row.userId);
      const dek = await from.unwrap(row.wrappedDek, aad, fromKekId);
      const wrapped = await to.wrap(dek, aad);
      if (!(await to.unwrap(wrapped, aad, toKekId)).equals(dek)) throw new Error("re-wrapped key does not unwrap to the same key: nothing was changed");
      if (!report.dryRun) await tx.update(userKeys).set({ wrappedDek: wrapped, kekId: toKekId }).where(eq(userKeys.userId, row.userId));
      report.rewrapped++;
    }
  });
  if (!report.dryRun) cache.clear();
  return report;
}
