import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@kassa/shared";

import { api } from "@/api/client";
import { signWithPasskey } from "@/lib/passkeys";
import { useSessionStore } from "@/stores/session";

import { signPasskeyChallenge } from "../passkey-sign";

jest.mock("@/api/client", () => ({ api: { request: jest.fn() } }));
jest.mock("@/lib/passkeys", () => ({ signWithPasskey: jest.fn() }));

const OPTIONS = {
  challenge: "orderhash-challenge-0123456789",
  rpId: "localhost",
} as unknown as PublicKeyCredentialRequestOptionsJSON;

const PLATFORM_ASSERTION = { id: "platform" } as unknown as AuthenticationResponseJSON;
const DEV_ASSERTION = { id: "dev-server-key" } as unknown as AuthenticationResponseJSON;

describe("signPasskeyChallenge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSessionStore.getState().setDev(false);
  });

  it("signs with the platform passkey in a normal session", async () => {
    jest.mocked(signWithPasskey).mockResolvedValue(PLATFORM_ASSERTION);

    await expect(signPasskeyChallenge(OPTIONS)).resolves.toBe(PLATFORM_ASSERTION);

    expect(signWithPasskey).toHaveBeenCalledWith(OPTIONS);
    expect(api.request).not.toHaveBeenCalled();
  });

  it("asks the server to sign the challenge in a dev session, not the platform", async () => {
    useSessionStore.getState().setDev(true);
    jest.mocked(api.request).mockResolvedValue({ assertion: DEV_ASSERTION });

    await expect(signPasskeyChallenge(OPTIONS)).resolves.toBe(DEV_ASSERTION);

    expect(api.request).toHaveBeenCalledWith(
      "/auth/dev/assert",
      expect.objectContaining({ json: { challenge: OPTIONS.challenge } })
    );
    expect(signWithPasskey).not.toHaveBeenCalled();
  });

  it("propagates a server refusal of the dev assertion without falling back to the platform", async () => {
    useSessionStore.getState().setDev(true);
    const refusal = new Error("NOT_FOUND");
    jest.mocked(api.request).mockRejectedValue(refusal);

    await expect(signPasskeyChallenge(OPTIONS)).rejects.toBe(refusal);
    expect(signWithPasskey).not.toHaveBeenCalled();
  });

  it("returns to the platform passkey once the dev flag is cleared", async () => {
    useSessionStore.getState().setDev(true);
    useSessionStore.getState().setDev(false);
    jest.mocked(signWithPasskey).mockResolvedValue(PLATFORM_ASSERTION);

    await expect(signPasskeyChallenge(OPTIONS)).resolves.toBe(PLATFORM_ASSERTION);
    expect(api.request).not.toHaveBeenCalled();
  });
});
