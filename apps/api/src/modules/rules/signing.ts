/*
 * Rules approval signing (spec §7): Approval = {orderHash, tier, issuedAt, expiresAt(+5 min), keyId},
 * signature = Ed25519 (RFC 8032, pure, via Node crypto) over utf8(JCS(approval)) (RFC 8785), base64url.
 */
import { jcs } from "@kassa/shared";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import { env } from "../../env.ts";
import { rulesPublicKey, type ApprovalSignedFields } from "./publicKey.ts";

let cache: { src: string; key: KeyObject } | null = null;

function signingKey(): KeyObject {
  const src = env().RULES_SIGNING_KEY;
  if (cache && cache.src === src) return cache.key;
  const key = createPrivateKey({ key: Buffer.from(src, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RULES_SIGNING_KEY must be Ed25519");
  cache = { src, key };
  return key;
}

export const APPROVAL_TTL_MS = 5 * 60_000;

export function signApproval(fields: Omit<ApprovalSignedFields, "keyId">): { fields: ApprovalSignedFields; sig: string } {
  const full: ApprovalSignedFields = { ...fields, keyId: rulesPublicKey().keyId };
  const sig = sign(null, Buffer.from(jcs(full), "utf8"), signingKey()).toString("base64url");
  return { fields: full, sig };
}
