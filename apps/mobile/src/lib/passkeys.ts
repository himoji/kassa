/**
 * Native passkeys (iOS AuthenticationServices / Android Credential Manager) through
 * react-native-passkeys (spec §3). The app only signs server-issued options: the challenge is
 * the orderHash / mandateHash / rules hash the server computed (spec §7, W3C WebAuthn L3).
 * Needs a development build with associated domains for the RP ID (not Expo Go).
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@kassa/shared";
import * as Passkeys from "react-native-passkeys";

import { PasskeyCancelledError, PasskeyUnsupportedError, toPasskeyError } from "./passkey-errors";

export { PasskeyCancelledError, PasskeyUnsupportedError } from "./passkey-errors";

export function passkeysSupported(): boolean {
  try {
    return Passkeys.isSupported();
  } catch {
    return false;
  }
}

/** Sign `options.challenge` with a passkey (user verification required, WebAuthn L3 §5.1.4). */
export async function signWithPasskey(
  options: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  if (!passkeysSupported()) throw new PasskeyUnsupportedError();
  try {
    const result = await Passkeys.get({
      ...options,
      userVerification: "required",
    } as Parameters<typeof Passkeys.get>[0]);
    if (!result) throw new PasskeyCancelledError();
    return result as unknown as AuthenticationResponseJSON;
  } catch (err) {
    throw toPasskeyError(err);
  }
}

/** Create a passkey for registration. */
export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON
): Promise<RegistrationResponseJSON> {
  if (!passkeysSupported()) throw new PasskeyUnsupportedError();
  try {
    const result = await Passkeys.create(options as Parameters<typeof Passkeys.create>[0]);
    if (!result) throw new PasskeyCancelledError();
    return result as unknown as RegistrationResponseJSON;
  } catch (err) {
    throw toPasskeyError(err);
  }
}
