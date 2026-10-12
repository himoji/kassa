/**
 * Where to land after sign-in. A signed-out user who opens a protected deep link (a till QR opens
 * `/pay/<billId>`) is sent to the welcome screen; the guard remembers the path here and the
 * sign-in screens (and the guard, whichever navigates first) send the user back to it. It is
 * cleared once the user arrives there. In memory only: the passkey flow does not reload the page.
 *
 * Only same-app relative paths are accepted (no scheme, no `//host`, no backslashes, no control
 * characters), so this can never become an open redirect.
 */
const ORIGIN = "https://kassa.invalid";
const AUTH_PATHS = /^\/(welcome|login|register)(\/|\?|#|$)/;

let pending: string | null = null;

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  if (raw === "/" || AUTH_PATHS.test(raw)) return null;
  try {
    if (new URL(raw, ORIGIN).origin !== ORIGIN) return null;
  } catch {
    return null;
  }
  return raw;
}

/** Remember `path` if it is a safe in-app path; an unsafe one leaves nothing pending. */
export function rememberReturnPath(path: unknown): void {
  pending = safeReturnPath(path);
}

/** The pending path, if any (not consumed: the guard and the sign-in screen may both ask). */
export function peekReturnPath(): string | null {
  return pending;
}

/** Called on arrival: forget the pending path once the user is on it. */
export function clearReturnPathIfAt(pathname: string): void {
  if (pending !== null && pending.split(/[?#]/)[0] === pathname) pending = null;
}

export function clearReturnPath(): void {
  pending = null;
}
