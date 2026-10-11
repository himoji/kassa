/**
 * RFC 9562 version-4 UUID from the platform CSPRNG (expo-crypto: SecRandomCopyBytes on iOS,
 * SecureRandom on Android, `crypto.randomUUID` on web). Never Math.random.
 */
import * as Crypto from "expo-crypto";

export function uuidv4(): string {
  return Crypto.randomUUID();
}
