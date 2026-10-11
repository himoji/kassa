/**
 * Kassa auth behind the kit's `@/lib/auth` contract: passkey sessions from `@/api/session`
 * (httpOnly cookie on web, keystore bearer tokens on native). Sign-up / sign-in themselves are
 * the passkey flows in `@/api/hooks/auth`.
 */
import { useMe } from "@/api/hooks/me";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";

import type { Auth, AuthUser, Session } from "./shims/auth";

export type { Auth, AuthUser, DeleteAccountOptions, Session, SessionStatus } from "./shims/auth";

function useSession(): Session {
  const status = useSessionStore((s) => s.status);
  const { data } = useMe();
  if (status !== "authenticated") return { user: null, status };
  const user: AuthUser = { id: data?.id ?? "", name: data?.displayName };
  return { user, status };
}

export const auth: Auth = {
  useSession,
  // Lazy: `@/api/session` imports the query client, which imports `@/lib/privacy`, which imports
  // this module - a static import would make that a load-order-dependent cycle.
  signOut: async () => {
    const { endSession } = await import("@/api/session");
    await endSession();
  },
  // Account deletion is not part of the competition build (spec §22 has no deletion flow).
  deleteAccount: () => Promise.reject(new Error("Account deletion is not available in this build")),
  getAuthHeaders: () => api.authHeaders(),
};
