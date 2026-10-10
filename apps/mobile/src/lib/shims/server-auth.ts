/**
 * No-op server auth (contract 5, server half). Replaced by the selected auth module's
 * `src/server/session.ts`; API routes only ever import `@/server/session`.
 *
 * Server-only: import it from `src/app/api/**` / `src/server/**`, never from app code
 * (real modules read server secrets and pull in server SDKs).
 */
import type { AuthUser } from "./auth";

export type { AuthUser } from "./auth";

/** Which auth module answers `getRequestUser` - `"none"` means nobody can be verified. */
export type ServerAuthProvider = "none" | "better-auth" | "supabase" | "clerk";

export interface ServerAuth {
  provider: ServerAuthProvider;
  /**
   * The user proven by the request's credentials (the headers from `auth.getAuthHeaders()`),
   * or `null` when there are none or they do not verify. Rejects only when the server itself
   * is misconfigured (missing secret) - answer 503, not 401, then.
   */
  getRequestUser(request: Request): Promise<AuthUser | null>;
}

export const serverAuth: ServerAuth = {
  provider: "none",
  getRequestUser: () => Promise.resolve(null),
};
