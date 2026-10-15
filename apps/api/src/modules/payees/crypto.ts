/*
 * Payee account details at rest: AES-256-GCM (NIST SP 800-38D) with a 96-bit random IV (§8.2.2 RBG-based
 * construction), 128-bit tag, AAD = "kassa:payee:v1:" + userId so a ciphertext cannot be moved to
 * another user. Stored as "v1.<iv>.<ciphertext>.<tag>" (base64url, RFC 4648 §5).
 */
import { maskPayeeAccount, normalizePayeeAccount, RecipientDetails, sha256Base64url } from "@kassa/shared";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../../env.ts";

function key(): Buffer {
  const k = Buffer.from(env().ACCOUNT_ENC_KEY, "base64");
  if (k.length !== 32) throw new Error("ACCOUNT_ENC_KEY must be 32 bytes (base64)");
  return k;
}

const aad = (userId: string) => Buffer.from(`kassa:payee:v1:${userId}`, "utf8");
/** Recipient details have their own AAD, so a details ciphertext can never be swapped in as an account. */
const detailsAad = (userId: string) => Buffer.from(`kassa:payee-details:v1:${userId}`, "utf8");

export function encryptAccount(userId: string, account: string, ad: Buffer = aad(userId)): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  cipher.setAAD(ad);
  const ct = Buffer.concat([cipher.update(account, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptAccount(userId: string, enc: string, ad: Buffer = aad(userId)): string {
  const [v, ivB, ctB, tagB] = enc.split(".");
  if (v !== "v1" || !ivB || ctB === undefined || !tagB) throw new Error("bad accountEnc format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"), { authTagLength: 16 });
  decipher.setAAD(ad);
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
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
  return encryptAccount(userId, JSON.stringify(details), detailsAad(userId));
}

/** The recipient's details, or null when none were given or they cannot be read (key rotated, old shape). */
export function readDetails(p: { userId: string; detailsEnc: string | null }): RecipientDetails | null {
  if (p.detailsEnc === null) return null;
  try {
    const parsed = RecipientDetails.safeParse(JSON.parse(decryptAccount(p.userId, p.detailsEnc, detailsAad(p.userId))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
