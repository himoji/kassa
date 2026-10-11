/*
 * The ONLY rules export payments may import (spec §4, ESLint): the rules approval public key.
 * RULES_PUBLIC_KEY is base64 SPKI DER (RFC 8410) of an Ed25519 key (RFC 8032). Outside production,
 * when it is unset, it is derived from the (ephemeral) signing key so local runs work.
 * keyId = RFC 7638 JWK thumbprint (base64url).
 */
import { jcs, sha256Base64url } from "@kassa/shared";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import { env } from "../../env.ts";

let cache: { src: string; key: KeyObject; keyId: string } | null = null;

export function rulesPublicKey(): { key: KeyObject; keyId: string } {
  const e = env();
  const src = e.RULES_PUBLIC_KEY || `derived:${e.RULES_SIGNING_KEY}`;
  if (cache && cache.src === src) return cache;
  const key = e.RULES_PUBLIC_KEY
    ? createPublicKey({ key: Buffer.from(e.RULES_PUBLIC_KEY, "base64"), format: "der", type: "spki" })
    : createPublicKey(createPrivateKey({ key: Buffer.from(e.RULES_SIGNING_KEY, "base64"), format: "der", type: "pkcs8" }));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RULES_PUBLIC_KEY must be Ed25519");
  const jwk = key.export({ format: "jwk" }) as { crv?: string; kty?: string; x?: string };
  const keyId = sha256Base64url(jcs({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
  cache = { src, key, keyId };
  return cache;
}

/** Fields covered by the approval signature (spec §7), in the order JCS will sort them anyway. */
export type ApprovalSignedFields = {
  orderHash: string;
  tier: "T1" | "T2";
  issuedAt: string;
  expiresAt: string;
  keyId: string;
};
