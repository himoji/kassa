import { z } from "zod";

/*
 * Wire shapes of WebAuthn JSON as produced by @simplewebauthn/browser / react-native-passkeys and
 * consumed by @simplewebauthn/server. Loose objects: the server library does the real verification.
 */

const B64url = z.string().regex(/^[A-Za-z0-9_-]*$/, "base64url");

export const AuthenticatorTransport = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export const PublicKeyCredentialRequestOptionsJSON = z.looseObject({
  challenge: B64url,
  timeout: z.number().int().positive().optional(),
  rpId: z.string().optional(),
  allowCredentials: z
    .array(
      z.looseObject({
        id: B64url,
        type: z.literal("public-key"),
        transports: z.array(AuthenticatorTransport).optional(),
      }),
    )
    .optional(),
  userVerification: z.enum(["required", "preferred", "discouraged"]).optional(),
});
export type PublicKeyCredentialRequestOptionsJSON = z.infer<typeof PublicKeyCredentialRequestOptionsJSON>;

export const AuthenticationResponseJSON = z.looseObject({
  id: B64url,
  rawId: B64url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: B64url,
    authenticatorData: B64url,
    signature: B64url,
    userHandle: B64url.optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});
export type AuthenticationResponseJSON = z.infer<typeof AuthenticationResponseJSON>;

export const RegistrationResponseJSON = z.looseObject({
  id: B64url,
  rawId: B64url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: B64url,
    attestationObject: B64url,
    transports: z.array(AuthenticatorTransport).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});
export type RegistrationResponseJSON = z.infer<typeof RegistrationResponseJSON>;
