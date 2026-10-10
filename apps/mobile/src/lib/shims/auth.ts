/** No-op auth (contract 5). Replaced by the selected auth module. */

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export type Session =
  | { user: AuthUser; status: "authenticated" }
  | { user: null; status: "loading" | "unauthenticated" };

export interface DeleteAccountOptions {
  /** Re-authenticates before deleting when the provider asks for it (`REAUTH_REQUIRED`). */
  password?: string;
}

export interface Auth {
  useSession(): Session;
  /** Ends the session; resolves once `useSession()` will report `unauthenticated`. */
  signOut(): Promise<void>;
  /**
   * Permanently deletes the signed-in user and ends the session (App Store Review
   * 5.1.1(v), Play "Account deletion"). Rejects with the provider's error. A provider that
   * needs a fresh sign-in rejects with `code: "REAUTH_REQUIRED"` (ask for the password and
   * call again with it), `"INVALID_PASSWORD"` or `"SIGN_IN_AGAIN"` (no password to check:
   * sign out and back in, then delete).
   */
  deleteAccount(options?: DeleteAccountOptions): Promise<void>;
  /**
   * Optional pre-flight for `deleteAccount(options)`: rejects with the same codes (or a plain
   * error, e.g. deletion switched off) while it can still be answered, before Settings erases
   * the user's analytics / purchase data on the server. Resolving means the provider will accept
   * the deletion. Modules that cannot tell in advance leave it out.
   */
  prepareDeleteAccount?(options?: DeleteAccountOptions): Promise<void>;
  /**
   * Headers that prove the current session to your own API routes (`src/app/api/**`), where
   * `serverAuth.getRequestUser(request)` (`src/server/session.ts`) turns them back into a user.
   * `{}` while signed out. Never send the user id instead: the server must not trust it.
   */
  getAuthHeaders(): Promise<Record<string, string>>;
  /**
   * Opens the module's sign-in screen (`/(auth)/sign-in`), e.g. from Settings → Developer
   * tools. Optional: the shim has no sign-in screen and leaves it out. A signed-in user is
   * sent straight back by `useAuthRedirect()`.
   */
  openSignIn?(): void;
}

const NO_SESSION: Session = { user: null, status: "unauthenticated" };

export const auth: Auth = {
  useSession: () => NO_SESSION,
  signOut: () => Promise.resolve(),
  deleteAccount: () => Promise.resolve(),
  getAuthHeaders: () => Promise.resolve({}),
};
