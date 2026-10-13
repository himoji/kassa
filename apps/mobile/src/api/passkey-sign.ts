/**
 * The one place a server challenge gets signed. Normal sessions sign with the platform passkey
 * (lib/passkeys). A dev session (POST /auth/dev/login, see stores/session `dev`) has no platform
 * passkey: the server signs the same challenge with its dev key (POST /auth/dev/assert), and that
 * assertion is returned in the place of a platform one. Every caller (order approval, withPasskeyGate,
 * the other sign-with-passkey mutations) goes through here, so the branch lives only here.
 */
import {
  AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@kassa/shared";
import { z } from "zod";

import { signWithPasskey } from "@/lib/passkeys";
import { useSessionStore } from "@/stores/session";

import { api } from "./client";

const DevAssertResponse = z.object({ assertion: AuthenticationResponseJSON });

/** The session store is persisted; wait for it so `dev` is read from storage, not the default. */
async function sessionIsDev(): Promise<boolean> {
  const { persist } = useSessionStore;
  if (!persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = persist.onFinishHydration(() => {
        unsubscribe();
        resolve();
      });
    });
  }
  return useSessionStore.getState().dev;
}

/** Sign `options.challenge` for the current session: platform passkey, or the dev assertion. */
export async function signPasskeyChallenge(
  options: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  if (!(await sessionIsDev())) return signWithPasskey(options);
  const { assertion } = await api.request("/auth/dev/assert", {
    json: { challenge: options.challenge },
    schema: DevAssertResponse,
  });
  return assertion;
}
