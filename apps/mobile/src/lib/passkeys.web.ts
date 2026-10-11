/**
 * Web passkeys through @simplewebauthn/browser (spec §3 web fallback). Needs a secure context
 * (HTTPS or localhost) whose origin matches the server's RP ID.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@kassa/shared";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

import { PasskeyCancelledError, PasskeyUnsupportedError, toPasskeyError } from "./passkey-errors";

export {
  PasskeyBiometricsError,
  PasskeyCancelledError,
  PasskeyDomainError,
  PasskeyUnsupportedError,
} from "./passkey-errors";

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

export async function signWithPasskey(
  options: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  if (!passkeysSupported()) throw new PasskeyUnsupportedError();
  try {
    const optionsJSON = { ...options, userVerification: "required" } as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"];
    const result = await startAuthentication({ optionsJSON });
    if (!result) throw new PasskeyCancelledError();
    return result as unknown as AuthenticationResponseJSON;
  } catch (err) {
    throw toPasskeyError(err, options.rpId);
  }
}

export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON
): Promise<RegistrationResponseJSON> {
  if (!passkeysSupported()) throw new PasskeyUnsupportedError();
  try {
    const optionsJSON = options as unknown as Parameters<
      typeof startRegistration
    >[0]["optionsJSON"];
    const result = await startRegistration({ optionsJSON });
    return result as unknown as RegistrationResponseJSON;
  } catch (err) {
    throw toPasskeyError(err, options.rp.id);
  }
}
