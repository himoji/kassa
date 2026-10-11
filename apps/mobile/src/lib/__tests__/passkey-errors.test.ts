import { describe, expect, it, jest } from "@jest/globals";

import { createPasskey } from "../passkeys";
import {
  isUnassociableRpId,
  PasskeyBiometricsError,
  PasskeyCancelledError,
  PasskeyDomainError,
  toPasskeyError,
} from "../passkey-errors";

const mockCreate = jest.fn(async () => ({ id: "cred" }));
jest.mock("react-native-passkeys", () => ({
  isSupported: () => true,
  create: (...args: unknown[]) => (mockCreate as (...a: unknown[]) => unknown)(...args),
  get: jest.fn(),
}));

/** The shape Expo modules reject with (code `ERR_*`, name "Error"). */
function expoError(code: string, message = "native failure"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isUnassociableRpId", () => {
  it.each(["localhost", "LOCALHOST", "dev.localhost", "127.0.0.1", "::1", "kassa", "", undefined])(
    "%p cannot carry an associated domain",
    (rpId) => expect(isUnassociableRpId(rpId)).toBe(true)
  );

  it.each(["kassa.example.com", "kassa.example.com."])("%p can", (rpId) =>
    expect(isUnassociableRpId(rpId)).toBe(false)
  );
});

describe("toPasskeyError", () => {
  it("no enrolled biometrics (react-native-passkeys ERR_BIOMETRIC) is its own error", () => {
    expect(toPasskeyError(expoError("ERR_BIOMETRIC"))).toBeInstanceOf(PasskeyBiometricsError);
  });

  it.each(["ERR_PASSKEY_REQUEST_FAILED", "ERR_NOT_CONFIGURED"])(
    "%s (iOS 1004 / 4004: app not associated with the RP ID) becomes PasskeyDomainError",
    (code) => {
      const err = toPasskeyError(expoError(code), "kassa.example.com");
      expect(err).toBeInstanceOf(PasskeyDomainError);
      expect((err as PasskeyDomainError).rpId).toBe("kassa.example.com");
    }
  );

  it("an Android RP ID mismatch (SecurityError) becomes PasskeyDomainError", () => {
    const err = Object.assign(new Error("The RP ID is invalid for this domain"), {
      name: "SecurityError",
    });
    expect(toPasskeyError(err, "localhost")).toBeInstanceOf(PasskeyDomainError);
  });

  it.each([
    expoError("ERR_USER_CANCELLED"),
    Object.assign(new Error("x"), { name: "NotAllowedError" }),
  ])("cancellation stays a cancellation", (err) => {
    expect(toPasskeyError(err)).toBeInstanceOf(PasskeyCancelledError);
  });

  it("anything else passes through unchanged", () => {
    const err = new Error("boom");
    expect(toPasskeyError(err)).toBe(err);
  });
});

describe("createPasskey (native)", () => {
  const options = (rpId: string) =>
    ({
      challenge: "Y2hhbGxlbmdl",
      rp: { id: rpId, name: "Kassa" },
      user: { id: "dXNlcg", name: "Dana", displayName: "Dana" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    }) as never;

  it("refuses an RP ID that cannot be associated before the OS sheet opens", async () => {
    mockCreate.mockClear();
    await expect(createPasskey(options("localhost"))).rejects.toBeInstanceOf(PasskeyDomainError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("calls the platform authenticator for a real domain", async () => {
    mockCreate.mockClear();
    await expect(createPasskey(options("kassa.example.com"))).resolves.toEqual({ id: "cred" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
