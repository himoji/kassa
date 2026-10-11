/**
 * Passkey-gated writes other than orders (I8 loosening): send once; if the server answers
 * 428 PASSKEY_REQUIRED with a challenge, sign it and resend the same body plus the assertion.
 */
import type { AuthenticationResponseJSON } from "@kassa/shared";

import { signWithPasskey } from "@/lib/passkeys";

import { KassaApiError } from "./errors";

export interface PasskeyProof {
  challengeId?: string;
  assertion?: AuthenticationResponseJSON;
}

export async function withPasskeyGate<T>(send: (proof: PasskeyProof) => Promise<T>): Promise<T> {
  try {
    return await send({});
  } catch (err) {
    const challenge = err instanceof KassaApiError ? err.passkeyChallenge : null;
    if (!challenge) throw err;
    const assertion = await signWithPasskey(challenge.webauthnOptions);
    return send({ challengeId: challenge.challengeId, assertion });
  }
}
