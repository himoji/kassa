/**
 * Session status (zustand, UI state only - the session itself is the cookie or the keystore
 * tokens). `loading` until `bootstrapSession()` settles; the API client flips it to
 * `unauthenticated` when the server ends the session.
 *
 * `dev` marks a dev-login session (server `POST /auth/dev/login`, demo + dev only). Its passkey
 * assertions are signed by the server-held dev passkey instead of the platform (`api/passkey-sign`).
 * It is persisted with the session so a relaunch keeps signing the same way, and cleared with it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { zustandStorage } from "./zustand-storage";

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface SessionState {
  status: SessionStatus;
  dev: boolean;
  setStatus(status: SessionStatus): void;
  setDev(dev: boolean): void;
}

export const SESSION_STORE_KEY = "kassa:session";

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      status: "loading",
      dev: false,
      setStatus: (status) => set({ status }),
      setDev: (dev) => set({ dev }),
    }),
    {
      name: SESSION_STORE_KEY,
      storage: createJSONStorage(() => zustandStorage),
      // Only the dev flag outlives a launch; `status` is always re-derived by bootstrapSession().
      partialize: (s) => ({ dev: s.dev }),
    }
  )
);
