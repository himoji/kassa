/**
 * Session status (zustand, UI state only - the session itself is the cookie or the keystore
 * tokens). `loading` until `bootstrapSession()` settles; the API client flips it to
 * `unauthenticated` when the server ends the session.
 */
import { create } from "zustand";

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface SessionState {
  status: SessionStatus;
  setStatus(status: SessionStatus): void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: "loading",
  setStatus: (status) => set({ status }),
}));
