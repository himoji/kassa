/*
 * Payee account details at rest: AES-256-GCM (NIST SP 800-38D) with a 96-bit random IV (§8.2.2 RBG-based
 * construction), 128-bit tag, AAD = "kassa:payee:v1:" + userId so a ciphertext cannot be moved to
 * another user. Stored as "v1.<iv>.<ciphertext>.<tag>" (base64url, RFC 4648 §5).
 */
import { sha256Base64url } from "@kassa/shared";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../../env.ts";
import { looksLikeIban, normalizeIban } from "../screening/iban.ts";

function key(): Buffer {
  const k = Buffer.from(env().ACCOUNT_ENC_KEY, "base64");
  if (k.length !== 32) throw new Error("ACCOUNT_ENC_KEY must be 32 bytes (base64)");
  return k;
}

const aad = (userId: string) => Buffer.from(`kassa:payee:v1:${userId}`, "utf8");

export function encryptAccount(userId: string, account: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(account, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptAccount(userId: string, enc: string): string {
  const [v, ivB, ctB, tagB] = enc.split(".");
  if (v !== "v1" || !ivB || ctB === undefined || !tagB) throw new Error("bad accountEnc format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"), { authTagLength: 16 });
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}

/** IBANs to ISO 13616 electronic format; other identifiers: strip spaces/hyphens, upper case. */
export function normalizeAccount(account: string): string {
  return looksLikeIban(account) ? normalizeIban(account) : account.replace(/[\s-]+/g, "").toUpperCase();
}

/** base64url(sha256(normalized account)) — CanonicalOrder.payeeAccountHash (spec §7). */
export function accountHash(account: string): string {
  return sha256Base64url(normalizeAccount(account));
}

export function maskAccount(account: string): string {
  const n = normalizeAccount(account);
  return n.length <= 4 ? `•••• ${n}` : `•••• ${n.slice(-4)}`;
}
