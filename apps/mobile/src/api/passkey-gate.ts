/**
 * Passkey-gated writes other than orders (I8 loosening): send once; if the server answers
 * 428 PASSKEY_REQUIRED with a challenge, sign it and resend the same body plus the assertion.
 */
import type { AuthenticationResponseJSON } from "@kassa/shared";

import { KassaApiError } from "./errors";
import { signPasskeyChallenge } from "./passkey-sign";

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
    const assertion = await signPasskeyChallenge(challenge.webauthnOptions);
    return send({ challengeId: challenge.challengeId, assertion });
  }
}
