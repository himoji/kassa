/*
 * Payments' own WebAuthn credential store (I2): webauthn_credentials_payments is written only here,
 * at registration (spec §7 "Registration"), and read only by payments verification.
 */
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { ReasonCode } from "@kassa/shared";
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { webauthnCredentialsPayments } from "../../db/schema.ts";
import { env } from "../../env.ts";

export async function registerPaymentsCredential(
  tx: DbOrTx,
  c: { userId: string; credentialId: string; publicKey: string; counter: number; transports: string[] },
): Promise<void> {
  await tx.insert(webauthnCredentialsPayments).values(c);
}

/** Account recovery (auth/recovery.ts): a backup code replaced every passkey, so payments forgets the old ones. */
export async function removePaymentsCredentials(tx: DbOrTx, userId: string): Promise<number> {
  return (await tx.delete(webauthnCredentialsPayments).where(eq(webauthnCredentialsPayments.userId, userId)).returning({ id: webauthnCredentialsPayments.id })).length;
}

function clientChallenge(a: AuthenticationResponseJSON): string | null {
  try {
    const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof cd.challenge === "string" ? cd.challenge : null;
  } catch {
    return null;
  }
}

export type PaymentsAssertionCheck = { ok: true } | { ok: false; reason: ReasonCode; detail: string };

/**
 * Verify an assertion against payments' credential table.
 * - live T2 assertions: `mode: "live"` enforces and advances this table's counter;
 * - stored mandate assertions (T1): `mode: "stored"` re-checks the signature over mandateHash only. The
 *   counter was checked when the mandate was signed; a stored signature is legitimately older than the
 *   current counter, so freshness comes from the mandate's own validity + used_nonces, not the counter.
 */
export async function verifyPaymentsAssertion(
  db: DbOrTx,
  opts: { userId: string; assertion: unknown; expectedChallenge: string; mode: "live" | "stored"; challengeReason: ReasonCode },
): Promise<PaymentsAssertionCheck> {
  const a = opts.assertion as AuthenticationResponseJSON | null;
  if (!a || typeof a !== "object" || typeof a.id !== "string" || !a.response) {
    return { ok: false, reason: "NO_APPROVAL", detail: "no user assertion" };
  }
  if (clientChallenge(a) !== opts.expectedChallenge) {
    return { ok: false, reason: opts.challengeReason, detail: "assertion challenge mismatch" };
  }
  const rows = await db
    .select()
    .from(webauthnCredentialsPayments)
    .where(and(eq(webauthnCredentialsPayments.credentialId, a.id), eq(webauthnCredentialsPayments.userId, opts.userId)));
  const cred = rows[0];
  if (!cred) return { ok: false, reason: "ASSERTION_INVALID", detail: "credential not in payments store" };
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
        counter: opts.mode === "live" ? cred.counter : 0,
        transports: cred.transports,
      },
    });
    if (!res.verified || !res.authenticationInfo.userVerified) {
      return { ok: false, reason: "ASSERTION_INVALID", detail: "assertion not verified" };
    }
    if (opts.mode === "live") {
      await db
        .update(webauthnCredentialsPayments)
        .set({ counter: res.authenticationInfo.newCounter })
        .where(eq(webauthnCredentialsPayments.id, cred.id));
    }
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const reason: ReasonCode = /counter/i.test(msg)
      ? "COUNTER_REGRESSION"
      : /verification/i.test(msg)
        ? "USER_NOT_VERIFIED"
        : "ASSERTION_INVALID";
    return { ok: false, reason, detail: msg };
  }
}
