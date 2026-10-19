/*
 * Payee account details at rest: AES-256-GCM (NIST SP 800-38D) with a 96-bit random IV (§8.2.2 RBG-based
 * construction), 128-bit tag. Stored as "<v>.<iv>.<ciphertext>.<tag>" (base64url, RFC 4648 §5).
 *  - v2 (A12, 2026-10-15): AAD = "kassa:payee:v2:" + userId + ":" + payeeId. A ciphertext cannot be moved to another
 *    user, nor to another payee row of the same user: someone who can write rows cannot re-point a verified payee at
 *    an account copied from a cooling one. Written whenever the payee id is known.
 *  - v1 (legacy): AAD = "kassa:payee:v1:" + userId. Still read; not bound to its row (docs/security/self-assessment.md R30).
 * Recipient details use their own AAD ("kassa:payee-details:v1:" + userId), so a details ciphertext can never be
 * swapped in as an account.
 */
import { maskPayeeAccount, normalizePayeeAccount, RecipientDetails, sha256Base64url } from "@kassa/shared";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../../env.ts";

function key(): Buffer {
  const k = Buffer.from(env().ACCOUNT_ENC_KEY, "base64");
  if (k.length !== 32) throw new Error("ACCOUNT_ENC_KEY must be 32 bytes (base64)");
  return k;
}

const accountAad = (v: "v1" | "v2", userId: string, payeeId?: string) => Buffer.from(v === "v1" ? `kassa:payee:v1:${userId}` : `kassa:payee:v2:${userId}:${payeeId}`, "utf8");
const detailsAad = (userId: string) => Buffer.from(`kassa:payee-details:v1:${userId}`, "utf8");

function seal(v: "v1" | "v2", ad: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  cipher.setAAD(ad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [v, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

function open(enc: string, adFor: (v: "v1" | "v2") => Buffer): string {
  const [v, ivB, ctB, tagB] = enc.split(".");
  if ((v !== "v1" && v !== "v2") || !ivB || ctB === undefined || !tagB) throw new Error("bad accountEnc format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"), { authTagLength: 16 });
  decipher.setAAD(adFor(v));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}

/** Encrypt a payee account. With the payee row's id it is bound to that row (v2); without it, the legacy v1 form. */
export function encryptAccount(userId: string, account: string, payeeId?: string): string {
  return payeeId ? seal("v2", accountAad("v2", userId, payeeId), account) : seal("v1", accountAad("v1", userId), account);
}

/** Decrypt a payee account. A v2 ciphertext decrypts only for the payee row it was written for (`payeeId`). */
export function decryptAccount(userId: string, enc: string, payeeId?: string): string {
  return open(enc, (v) => {
    if (v === "v2" && !payeeId) throw new Error("a v2 accountEnc needs its payee id");
    return accountAad(v, userId, payeeId);
  });
}

/**
 * One canonical form per account (shared/payeeAccount.ts): IBANs in ISO 13616 electronic format, Alipay / UnionPay /
 * ACH re-encoded from their fields, other identifiers stripped of spaces and hyphens and upper-cased.
 */
export function normalizeAccount(account: string): string {
  return normalizePayeeAccount(account);
}

/** base64url(sha256(normalized account)) — CanonicalOrder.payeeAccountHash (spec §7). */
export function accountHash(account: string): string {
  return sha256Base64url(normalizeAccount(account));
}

export function maskAccount(account: string): string {
  return maskPayeeAccount(account);
}

export function encryptDetails(userId: string, details: RecipientDetails): string {
  return seal("v1", detailsAad(userId), JSON.stringify(details));
}

/** The recipient's details, or null when none were given or they cannot be read (key rotated, old shape). */
export function readDetails(p: { userId: string; detailsEnc: string | null }): RecipientDetails | null {
  if (p.detailsEnc === null) return null;
  try {
    // Details are always the v1 form under their own AAD; a v2 (account) ciphertext never opens here.
    const parsed = RecipientDetails.safeParse(JSON.parse(open(p.detailsEnc, (v) => (v === "v1" ? detailsAad(p.userId) : Buffer.from("kassa:payee-details:never")))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
