/** The user dismissed the passkey prompt (WebAuthn `NotAllowedError`, iOS/Android cancel). */
export class PasskeyCancelledError extends Error {
  constructor() {
    super("Passkey prompt was cancelled");
    this.name = "PasskeyCancelledError";
  }
}

/** This device / browser cannot use passkeys (no WebAuthn, or not a development build). */
export class PasskeyUnsupportedError extends Error {
  constructor() {
    super("Passkeys are not supported here");
    this.name = "PasskeyUnsupportedError";
  }
}

/**
 * The OS refused the ceremony because this app is not associated with the RP ID's domain.
 * Native passkeys are bound to a website: iOS needs the `webcredentials:<rpId>` associated-domains
 * entitlement plus `https://<rpId>/.well-known/apple-app-site-association` listing the app, Android
 * needs `https://<rpId>/.well-known/assetlinks.json`. "localhost" or an IP can never satisfy that,
 * so a local API (RP_ID=localhost) works on web but not in the native app (README "Passkeys").
 */
export class PasskeyDomainError extends Error {
  constructor(
    readonly rpId: string | undefined,
    detail?: string
  ) {
    super(
      `Passkeys need the app's domain (RP ID ${rpId ?? "unknown"})${detail ? `: ${detail}` : ""}`
    );
    this.name = "PasskeyDomainError";
  }
}

/**
 * The device has no biometrics enrolled. react-native-passkeys (iOS) refuses before showing any
 * sheet unless `LAContext.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)` passes
 * (`ERR_BIOMETRIC`); a fresh iOS Simulator has no Face ID enrolled (Features > Face ID > Enrolled).
 */
export class PasskeyBiometricsError extends Error {
  constructor() {
    super("Passkeys need Face ID or Touch ID enrolled on this device");
    this.name = "PasskeyBiometricsError";
  }
}

/**
 * True when `rpId` cannot be backed by an associated domain: "localhost" (and `*.localhost`,
 * RFC 6761 §6.3), an IP literal, or a single-label name. WebAuthn L3 §5.1.3 requires the RP ID to
 * be a registrable domain suffix of the origin; the platform's app-to-domain check needs it to
 * serve the association file over HTTPS.
 */
export function isUnassociableRpId(rpId: string | undefined): boolean {
  if (!rpId) return true;
  const host = rpId.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return true;
  return !host.includes(".");
}

const CANCEL_NAMES = new Set(["NotAllowedError", "AbortError", "UserCancelledError"]);

/**
 * react-native-passkeys (iOS) maps ASAuthorizationError 4004 to `NotConfiguredException` and 1004
 * (request failed) to `PasskeyRequestFailedException`; Expo turns them into `ERR_NOT_CONFIGURED` /
 * `ERR_PASSKEY_REQUEST_FAILED`. A missing association arrives as 1004 with no description: the
 * reason ("Application with identifier … is not associated with domain …") is only in the OS log
 * (observed on the iOS 26.5 simulator, 2026-10-11). The options are server-generated, so 1004 is
 * treated as the domain problem. Android Credential Manager reports an RP ID / Digital Asset
 * Links mismatch as a DOM `SecurityError`.
 */
function isDomainFailure(name: string | undefined, code: string | undefined, message: string) {
  if (code === "ERR_NOT_CONFIGURED" || code === "ERR_PASSKEY_REQUEST_FAILED") return true;
  if (/not associated with domain|associated domains?|apple-app-site-association/i.test(message))
    return true;
  return name === "SecurityError" && /rp ?id|relying party|asset ?links|domain/i.test(message);
}

/**
 * Normalise library errors: cancellation becomes `PasskeyCancelledError`, a missing app-domain
 * association `PasskeyDomainError` (`rpId` names the domain the app would need), the rest pass
 * through.
 */
export function toPasskeyError(err: unknown, rpId?: string): Error {
  if (
    err instanceof PasskeyCancelledError ||
    err instanceof PasskeyUnsupportedError ||
    err instanceof PasskeyDomainError ||
    err instanceof PasskeyBiometricsError
  )
    return err;
  const name = (err as { name?: string; code?: string } | null)?.name;
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ERR_BIOMETRIC") return new PasskeyBiometricsError();
  if (isDomainFailure(name, code, message)) return new PasskeyDomainError(rpId, message);
  if (
    (name && CANCEL_NAMES.has(name)) ||
    code === "ERROR_CEREMONY_ABORTED" ||
    code === "UserCancelled" ||
    // react-native-passkeys iOS: ASAuthorizationError 1001 → UserCancelledException.
    code === "ERR_USER_CANCELLED"
  ) {
    return new PasskeyCancelledError();
  }
  return err instanceof Error ? err : new Error(String(err));
}
