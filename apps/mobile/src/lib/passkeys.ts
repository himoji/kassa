/**
 * Native passkeys (iOS AuthenticationServices / Android Credential Manager) through
 * react-native-passkeys (spec §3). The app only signs server-issued options: the challenge is
 * the orderHash / mandateHash / rules hash the server computed (spec §7, W3C WebAuthn L3).
 * Needs a development build with associated domains for the RP ID (not Expo Go).
 *
 * The package is loaded lazily: it throws on import when its native half is not in the binary (Expo Go, a dev
 * client built before it was added). A top-level import would take down every route that imports this file
 * ("Cannot find native module 'ReactNativePasskeys'"); lazily it is just "passkeys unsupported", and the Dev
 * passkey button still works.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@kassa/shared";
import type * as PasskeysModule from "react-native-passkeys";

import {
  isUnassociableRpId,
  PasskeyCancelledError,
  PasskeyDomainError,
  PasskeyUnsupportedError,
  toPasskeyError,
} from "./passkey-errors";

export {
  PasskeyBiometricsError,
  PasskeyCancelledError,
  PasskeyDomainError,
  PasskeyUnsupportedError,
} from "./passkey-errors";

/**
 * Fail before the OS sheet when the RP ID can never be associated with this app (a local API
 * with RP_ID=localhost): iOS would only answer with an opaque ASAuthorizationError.
 */
function assertAssociableRpId(rpId: string | undefined): void {
  if (isUnassociableRpId(rpId)) throw new PasskeyDomainError(rpId);
}

let loaded: typeof PasskeysModule | null | undefined;

function passkeys(): typeof PasskeysModule | null {
  if (loaded === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose, see the header
      loaded = require("react-native-passkeys") as typeof PasskeysModule;
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

export function passkeysSupported(): boolean {
  try {
    return passkeys()?.isSupported() ?? false;
  } catch {
    return false;
  }
}

/** Sign `options.challenge` with a passkey (user verification required, WebAuthn L3 §5.1.4). */
export async function signWithPasskey(
  options: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  if (!passkeysSupported()) throw new PasskeyUnsupportedError();
  assertAssociableRpId(options.rpId);
  try {
    const result = await passkeys()!.get({
      ...options,
      userVerification: "required",
    } as Parameters<typeof PasskeysModule.get>[0]);
    if (!result) throw new PasskeyCancelledError();
    return result as unknown as AuthenticationResponseJSON;
  } catch (err) {
    throw toPasskeyError(err, options.rpId);
  }
}

/** Create a passkey for registration. */
export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON
): Promise<RegistrationResponseJSON> {
  if (!passkeysSupported()) throw new PasskeyUnsupportedError();
  assertAssociableRpId(options.rp.id);
  try {
    const result = await passkeys()!.create(options as Parameters<typeof PasskeysModule.create>[0]);
    if (!result) throw new PasskeyCancelledError();
    return result as unknown as RegistrationResponseJSON;
  } catch (err) {
    throw toPasskeyError(err, options.rp.id);
  }
}
