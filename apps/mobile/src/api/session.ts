/**
 * Session lifecycle on top of the API client: bootstrap at launch, sign in from an
 * `AuthSessionResponse`, sign out. Status lives in `useSessionStore` (zustand).
 */
import { MeResponse, type AuthSessionResponse } from "@kassa/shared";

import { queryClient } from "@/lib/query";
import { useSessionStore } from "@/stores/session";

import { api, onSessionLost } from "./client";
import { isUnauthorized } from "./errors";
import { keys } from "./keys";
import { tokenStore } from "./token-store";

let bootstrapped: Promise<void> | null = null;

onSessionLost(() => {
  void api.setTokens(null);
  useSessionStore.getState().setDev(false);
  useSessionStore.getState().setStatus("unauthenticated");
});

/**
 * Native: a stored refresh token means signed in (GET /me then validates it). Web: the cookie is
 * invisible to JS, so ask GET /me. A network failure keeps the user "signed in" so screens can
 * show their own error and retry instead of bouncing to the welcome screen.
 */
export function bootstrapSession(): Promise<void> {
  bootstrapped ??= (async () => {
    const { setStatus, setDev } = useSessionStore.getState();
    if (api.kind === "native") {
      const signedIn = await api.hasSession();
      if (!signedIn) setDev(false);
      setStatus(signedIn ? "authenticated" : "unauthenticated");
      return;
    }
    try {
      const me = await api.request("/me", { schema: MeResponse });
      queryClient.setQueryData(keys.me, me);
      setStatus("authenticated");
    } catch (err) {
      const signedOut = isUnauthorized(err);
      if (signedOut) setDev(false);
      setStatus(signedOut ? "unauthenticated" : "authenticated");
    }
  })();
  return bootstrapped;
}

/** Starts a session from an auth response. `dev` is true only for POST /auth/dev/login. */
export async function startSession(
  result: AuthSessionResponse,
  options: { dev?: boolean } = {}
): Promise<void> {
  await api.setTokens(result.tokens);
  queryClient.clear();
  const session = useSessionStore.getState();
  session.setDev(options.dev === true);
  session.setStatus("authenticated");
}

export async function endSession(): Promise<void> {
  try {
    const tokens = await tokenStore.load();
    await api.request("/auth/logout", {
      method: "POST",
      json: tokens ? { refreshToken: tokens.refreshToken } : {},
    });
  } catch {
    // Best effort: the local session ends regardless (RFC 6749 §10.4 tokens expire anyway).
  }
  await api.setTokens(null);
  queryClient.clear();
  useSessionStore.getState().setDev(false);
  useSessionStore.getState().setStatus("unauthenticated");
}
