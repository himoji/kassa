/*
 * Offline check of a downloaded credit record (GET /api/public/credit-record/<id>.json) against a JWKS
 * (GET /api/public/keys): the bundle's JCS SHA-256 (RFC 8785) equals `sha256`, and the Ed25519 signature (RFC 8032)
 * verifies under the key whose kid (RFC 7638 thumbprint) the file names. v3 signs utf8("kassa:credit-record:v3:" +
 * sha256); v1/v2 signed utf8(sha256). Pure: no database, no server key (scripts/credit-verify.ts).
 */
import { jcs, jcsHash, sha256Base64url } from "@kassa/shared";
import { createPublicKey, verify } from "node:crypto";

export type CreditRecordFile = { bundle: { v?: number } & Record<string, unknown>; sha256: string; sig: string; keyId: string; alg?: string };
export type Jwks = { keys: { kty: string; crv: string; x: string; kid?: string }[] };

export type OfflineCheck = { ok: boolean; hashMatches: boolean; keyFound: boolean; signatureValid: boolean; version: number; keyId: string };

export function verifyCreditRecordOffline(file: CreditRecordFile, jwks: Jwks): OfflineCheck {
  const version = Number(file.bundle.v ?? 1);
  const hashMatches = jcsHash(file.bundle) === file.sha256;
  // The kid is recomputed from the key material, never trusted from the JWKS.
  const jwk = jwks.keys.find((k) => k.kty === "OKP" && k.crv === "Ed25519" && sha256Base64url(jcs({ crv: k.crv, kty: k.kty, x: k.x })) === file.keyId);
  let signatureValid = false;
  if (jwk) {
    const message = version >= 3 ? `kassa:credit-record:v3:${file.sha256}` : file.sha256;
    try {
      const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
      signatureValid = verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(file.sig, "base64url"));
    } catch {
      signatureValid = false;
    }
  }
  return { ok: hashMatches && signatureValid, hashMatches, keyFound: jwk !== undefined, signatureValid, version, keyId: file.keyId };
}
