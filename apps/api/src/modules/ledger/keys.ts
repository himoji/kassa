/*
 * Ed25519 (RFC 8032) key helpers for ledger checkpoints. Keys are base64 DER: PKCS#8 private, SPKI public
 * (RFC 8410), as written by scripts/keys-generate.ts. keyId = RFC 7638 JWK thumbprint of the public key
 * (RFC 8037 OKP members crv/kty/x, which JCS already orders lexicographically as RFC 7638 §3 requires).
 */
import { jcs, sha256Base64url } from "@kassa/shared";
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export function loadPrivateKey(b64: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("expected an Ed25519 private key");
  return key;
}

export function loadPublicKey(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("expected an Ed25519 public key");
  return key;
}

export function publicFromPrivate(priv: KeyObject): KeyObject {
  return createPublicKey(priv);
}

/** RFC 7638 thumbprint, base64url (RFC 4648 §5). */
export function keyIdOf(pub: KeyObject): string {
  const jwk = pub.export({ format: "jwk" }) as { crv?: string; kty?: string; x?: string };
  return sha256Base64url(jcs({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
}

/** Ed25519 signature over utf8(message), base64url. Node uses pure Ed25519 when the algorithm is null. */
export function signText(priv: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), priv).toString("base64url");
}

export function verifyText(pub: KeyObject, message: string, sigB64url: string): boolean {
  try {
    return verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(sigB64url, "base64url"));
  } catch {
    return false;
  }
}
