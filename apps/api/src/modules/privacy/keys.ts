/*
 * Per-user data encryption keys (GDPR Art. 17 erasure by crypto-shredding, Art. 32 encryption).
 *
 * - DEK: 32 random bytes per user, AES-256-GCM (NIST SP 800-38D): 96-bit random IV (§8.2.2), 128-bit tag.
 * - KEK: USER_KEK from env. The DEK is stored wrapped: AES-256-GCM(KEK, DEK, AAD = "kassa:dek:v1:" + userId),
 *   so a wrapped key cannot be moved to another user. (AES-GCM wrapping instead of RFC 3394 AES-KW: one
 *   primitive in the codebase, authenticated, and the AAD binds the owner.)
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
import { eq } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { userKeys } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";

const VERSION = "v1";

function kek(): Buffer {
  const k = Buffer.from(env().USER_KEK, "base64");
  if (k.length !== 32) throw new Error("USER_KEK must be 32 bytes (base64)");
  return k;
}

/** Short public identifier of the KEK (to detect a rotated/mismatched KEK). */
export function kekId(): string {
  return createHash("sha256").update(kek()).digest("base64url").slice(0, 16);
}

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
    await db
      .insert(userKeys)
      .values({ userId, wrappedDek: seal(kek(), dek, dekAad(userId)), kekId: kekId(), createdAt: clock.now() })
      .onConflictDoNothing();
    // Re-read: a concurrent creator may have won the insert.
    row = (await db.select().from(userKeys).where(eq(userKeys.userId, userId)))[0];
    if (!row) throw new Error("user key could not be created");
  }
  if (!row.wrappedDek) {
    cache.set(userId, null);
    return null;
  }
  const dek = open(kek(), row.wrappedDek, dekAad(userId));
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
