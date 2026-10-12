/**
 * Passkey sign-up and sign-in (spec §8). The server returns WebAuthn options + a challenge id;
 * the platform authenticator answers; /verify starts the session (cookie on web, tokens on native).
 */
import {
  AuthSessionResponse,
  LoginOptionsResponse,
  RegisterOptionsResponse,
  type ClientKind,
} from "@kassa/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { createPasskey, signWithPasskey } from "@/lib/passkeys";

import { api } from "../client";
import { keys } from "../keys";
import { startSession } from "../session";

const client: ClientKind = api.kind;

/** GET /auth/demo: whether the server runs in demo mode (DEMO_ENABLED). Public, no session. */
const DemoAvailability = z.object({ enabled: z.boolean() });

export function useDemoAvailability() {
  return useQuery({
    queryKey: keys.demoAvailability,
    queryFn: ({ signal }) =>
      api.request("/auth/demo", { schema: DemoAvailability, auth: false, signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export interface RegisterInput {
  displayName: string;
  /**
   * Demo mode only: bind this new passkey to the seeded demo account instead of creating a user
   * (server `demoClaim`): `true` = the seeded hero, a string = that seeded persona key. Still a full
   * passkey ceremony; the server refuses it once claimed.
   */
  demoClaim?: true | string;
}

export function useRegister() {
  return useMutation({
    mutationFn: async ({ displayName, demoClaim }: RegisterInput) => {
      const { challengeId, options } = await api.request("/auth/register/options", {
        json: demoClaim ? { displayName, demoClaim } : { displayName },
        schema: RegisterOptionsResponse,
        auth: false,
      });
      const response = await createPasskey(options);
      const session = await api.request("/auth/register/verify", {
        json: { challengeId, response, client },
        schema: AuthSessionResponse,
        auth: false,
      });
      await startSession(session);
      return session;
    },
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await api.request("/auth/login/options", {
        json: {},
        schema: LoginOptionsResponse,
        auth: false,
      });
      const response = await signWithPasskey(options);
      const session = await api.request("/auth/login/verify", {
        json: { challengeId, response, client },
        schema: AuthSessionResponse,
        auth: false,
      });
      await startSession(session);
      return session;
    },
  });
}
