/*
 * WebAuthn assertion verification for the rules module (spec §7 "Rules verification"), against
 * webauthn_credentials_rules only. Checks (W3C WebAuthn L3 §7.2 via @simplewebauthn/server):
 * challenge == expected (orderHash / mandateHash / changeHash), origin and RP ID match, UV flag set,
 * signature valid, and the signature counter does not go backwards — a counter of 0 is accepted
 * because synced passkeys always report 0 (§6.1.1).
 */
import type { ReasonCode } from "@kassa/shared";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { webauthnCredentialsRules } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { challengeOf } from "../auth/challenges.ts";

export type AssertionCheck =
  | { ok: true; credentialId: string; newCounter: number }
  | { ok: false; reason: ReasonCode; detail: string };

export function mapWebauthnError(message: string, challengeReason: ReasonCode): ReasonCode {
  if (/challenge/i.test(message)) return challengeReason;
  if (/user verification|could not be verified/i.test(message)) return "USER_NOT_VERIFIED";
  if (/counter/i.test(message)) return "COUNTER_REGRESSION";
  return "ASSERTION_INVALID";
}

export async function verifyRulesAssertion(
  db: DbOrTx,
  opts: {
    userId: string;
    assertion: unknown;
    expectedChallenge: string;
    /** Reason code when the challenge differs (ORDER_HASH_MISMATCH for orders). */
    challengeReason?: ReasonCode;
    /** Persist the new counter (true for live assertions). */
    updateCounter?: boolean;
  },
): Promise<AssertionCheck> {
  const challengeReason = opts.challengeReason ?? "ORDER_HASH_MISMATCH";
  const a = opts.assertion as AuthenticationResponseJSON | null;
  if (!a || typeof a !== "object" || typeof a.id !== "string" || !a.response) {
    return { ok: false, reason: "ASSERTION_INVALID", detail: "missing assertion" };
  }
  const got = challengeOf(a);
  if (got !== opts.expectedChallenge) {
    return { ok: false, reason: challengeReason, detail: "assertion challenge does not match" };
  }
  const rows = await db
    .select()
    .from(webauthnCredentialsRules)
    .where(and(eq(webauthnCredentialsRules.credentialId, a.id), eq(webauthnCredentialsRules.userId, opts.userId)));
  const cred = rows[0];
  if (!cred) return { ok: false, reason: "ASSERTION_INVALID", detail: "unknown credential for this user" };
  const e = env();
  try {
    const res = await verifyAuthenticationResponse({
      response: a,
      expectedChallenge: opts.expectedChallenge,
      expectedOrigin: e.origins,
      expectedRPID: e.RP_ID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
    if (!res.verified) return { ok: false, reason: "ASSERTION_INVALID", detail: "signature not verified" };
    if (!res.authenticationInfo.userVerified) {
      return { ok: false, reason: "USER_NOT_VERIFIED", detail: "user verification flag not set" };
    }
    if (opts.updateCounter !== false) {
      await db
        .update(webauthnCredentialsRules)
        .set({ counter: res.authenticationInfo.newCounter })
        .where(eq(webauthnCredentialsRules.id, cred.id));
    }
    return { ok: true, credentialId: cred.credentialId, newCounter: res.authenticationInfo.newCounter };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { ok: false, reason: mapWebauthnError(msg, challengeReason), detail: msg };
  }
}

/** Request options whose challenge is a server value (orderHash etc.), for the app's startAuthentication. */
export async function assertionOptions(db: DbOrTx, userId: string, challenge: string) {
  const creds = await db
    .select({ credentialId: webauthnCredentialsRules.credentialId, transports: webauthnCredentialsRules.transports })
    .from(webauthnCredentialsRules)
    .where(eq(webauthnCredentialsRules.userId, userId));
  return {
    challenge,
    timeout: 120_000,
    rpId: env().RP_ID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      type: "public-key" as const,
      transports: c.transports as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[],
    })),
    userVerification: "required" as const,
  };
}
