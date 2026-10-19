/*
 * Credit record keys (v3, 2026-10-19).
 *
 * - Signing key: CREDIT_RECORD_KEY (base64 PKCS#8 Ed25519, like the other keys) when set; otherwise an Ed25519 key
 *   DERIVED from LEDGER_CHECKPOINT_KEY with a domain-separated HMAC-SHA256 (label "kassa:credit-record-key:v1"), so a
 *   deployment needs no new secret and a credit record signature can never be mistaken for a ledger checkpoint one.
 * - Signed message: "kassa:credit-record:v3:" + sha256 (domain separation). Records v1/v2 were signed over the bare
 *   sha256 with the ledger checkpoint key and keep verifying that way.
 * - Holder name: an HMAC-SHA256 of the normalised full name under a key derived from the signing key (label
 *   "kassa:credit-record-name:v1") and a per-record salt. Keyed, so the public bundle does not let anyone guess the
 *   name offline from a list of names; the verify route answers match / no match for a name the reader types in.
 * - GET /public/keys publishes both public keys as a JWKS (RFC 7517, OKP RFC 8037), kid = RFC 7638 thumbprint.
 */
import { createHmac, createPrivateKey, type KeyObject } from "node:crypto";

import { env } from "../../env.ts";
import { checkpointPublicKey } from "../ledger/index.ts";
import { keyIdOf, loadPrivateKey, publicFromPrivate, signText, verifyText } from "../ledger/keys.ts";
import { normalizeName } from "../screening/normalize.ts";

/** RFC 8410 PKCS#8 prefix of a raw 32-byte Ed25519 seed. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function seedOf(priv: KeyObject): Buffer {
  const der = priv.export({ format: "der", type: "pkcs8" });
  return der.subarray(der.length - 32);
}

function derive(seed: Buffer, label: string): Buffer {
  return createHmac("sha256", seed).update(label, "utf8").digest();
}

let cached: { source: string; key: KeyObject } | null = null;

export function creditRecordKey(): KeyObject {
  const e = env();
  const source = e.CREDIT_RECORD_KEY ? `own:${e.CREDIT_RECORD_KEY}` : `derived:${e.LEDGER_CHECKPOINT_KEY}`;
  if (cached?.source === source) return cached.key;
  const key = e.CREDIT_RECORD_KEY
    ? loadPrivateKey(e.CREDIT_RECORD_KEY)
    : createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, derive(seedOf(loadPrivateKey(e.LEDGER_CHECKPOINT_KEY)), "kassa:credit-record-key:v1")]), format: "der", type: "pkcs8" });
  cached = { source, key };
  return key;
}

export function creditRecordPublicKey(): KeyObject {
  return publicFromPrivate(creditRecordKey());
}

/** The message a record's signature covers: domain-separated from v3 on; the bare hash for v1/v2. */
export function signedMessage(version: number, sha256: string): string {
  return version >= 3 ? `kassa:credit-record:v3:${sha256}` : sha256;
}

/** The key that signs records of `version` (v1/v2: the ledger checkpoint key). */
export function publicKeyFor(version: number): KeyObject {
  return version >= 3 ? creditRecordPublicKey() : checkpointPublicKey();
}

export function signRecord(sha256: string): { sig: string; keyId: string } {
  return { sig: signText(creditRecordKey(), signedMessage(3, sha256)), keyId: keyIdOf(creditRecordPublicKey()) };
}

export function verifyRecord(version: number, sha256: string, sig: string, keyId: string): boolean {
  const pub = publicKeyFor(version);
  return keyId === keyIdOf(pub) && verifyText(pub, signedMessage(version, sha256), sig);
}

/** Keyed, salted hash of a normalised full name (base64url). */
export function holderNameHash(name: string, salt: string): string {
  const k = derive(seedOf(creditRecordKey()), "kassa:credit-record-name:v1");
  return createHmac("sha256", k).update(`${salt}:${normalizeName(name)}`, "utf8").digest("base64url");
}

type Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string; use: "sig"; alg: "EdDSA"; "kassa:signs": string };

function jwkOf(pub: KeyObject, signs: string): Jwk {
  const j = pub.export({ format: "jwk" }) as { x: string };
  return { kty: "OKP", crv: "Ed25519", x: j.x, kid: keyIdOf(pub), use: "sig", alg: "EdDSA", "kassa:signs": signs };
}

/** GET /public/keys: the credit record key (v3 records) and the ledger checkpoint key (ledger, v1/v2 records). */
export function publicJwks(): { keys: Jwk[] } {
  return {
    keys: [
      jwkOf(creditRecordPublicKey(), "credit records v3: Ed25519 over utf8('kassa:credit-record:v3:' + sha256)"),
      jwkOf(checkpointPublicKey(), "ledger checkpoints and head; credit records v1/v2: Ed25519 over utf8(sha256)"),
    ],
  };
}
