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

const CANCEL_NAMES = new Set(["NotAllowedError", "AbortError", "UserCancelledError"]);

/** Normalise library errors: cancellation becomes `PasskeyCancelledError`, the rest pass through. */
export function toPasskeyError(err: unknown): Error {
  if (err instanceof PasskeyCancelledError || err instanceof PasskeyUnsupportedError) return err;
  const name = (err as { name?: string; code?: string } | null)?.name;
  const code = (err as { code?: string } | null)?.code;
  if (
    (name && CANCEL_NAMES.has(name)) ||
    code === "ERROR_CEREMONY_ABORTED" ||
    code === "UserCancelled"
  ) {
    return new PasskeyCancelledError();
  }
  return err instanceof Error ? err : new Error(String(err));
}
