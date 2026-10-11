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
import { useMutation } from "@tanstack/react-query";

import { createPasskey, signWithPasskey } from "@/lib/passkeys";

import { api } from "../client";
import { startSession } from "../session";

const client: ClientKind = api.kind;

export function useRegister() {
  return useMutation({
    mutationFn: async (displayName: string) => {
      const { challengeId, options } = await api.request("/auth/register/options", {
        json: { displayName },
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
