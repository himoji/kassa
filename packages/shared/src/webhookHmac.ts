import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/*
 * Mock-world webhook authentication (spec §2 I13):
 *   X-Kassa-Timestamp: unix seconds
 *   X-Kassa-Signature: hex(HMAC-SHA256(MOCK_HMAC_SECRET, `${timestamp}.${rawBody}`))
 * HMAC per RFC 2104 with SHA-256 (FIPS 180-4); hex is lower case (RFC 4648 §8 base16).
 * Pure JS (@noble/hashes) so the signer (mock-world) and the verifier (api) share one implementation.
 */

export const MOCK_WEBHOOK_TIMESTAMP_HEADER = "x-kassa-timestamp";
export const MOCK_WEBHOOK_SIGNATURE_HEADER = "x-kassa-signature";
/** Replay window: 5 minutes either side of the receiver's clock. */
export const MOCK_WEBHOOK_WINDOW_SECONDS = 300;

/** hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)). */
export function signMockWebhook(secret: string, timestamp: number, rawBody: string): string {
  if (!secret) throw new Error("signMockWebhook: empty secret");
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError("signMockWebhook: bad timestamp");
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${timestamp}.${rawBody}`)));
}

/** Headers to send with a signed body. `nowSeconds` is the sender's clock (unix seconds). */
export function mockWebhookHeaders(secret: string, rawBody: string, nowSeconds: number): Record<string, string> {
  const ts = Math.floor(nowSeconds);
  return {
    [MOCK_WEBHOOK_TIMESTAMP_HEADER]: String(ts),
    [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(secret, ts, rawBody),
  };
}

export type MockWebhookVerifyResult =
  | { ok: true }
  | { ok: false; code: "WEBHOOK_SIGNATURE_INVALID" | "WEBHOOK_REPLAY_WINDOW" };

/** Constant-time comparison of two equal-length lower-case hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a received webhook. `timestampHeader`/`signatureHeader` are the raw header values;
 * `rawBody` must be the exact bytes received (decoded as UTF-8), not a re-serialised object.
 */
export function verifyMockWebhook(
  secret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  rawBody: string,
  nowSeconds: number,
  windowSeconds: number = MOCK_WEBHOOK_WINDOW_SECONDS,
): MockWebhookVerifyResult {
  if (!timestampHeader || !signatureHeader || !/^\d{1,12}$/.test(timestampHeader)) {
    return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  }
  const ts = Number(timestampHeader);
  const expected = signMockWebhook(secret, ts, rawBody);
  if (!timingSafeEqualHex(expected, signatureHeader.trim().toLowerCase())) {
    return { ok: false, code: "WEBHOOK_SIGNATURE_INVALID" };
  }
  if (Math.abs(Math.floor(nowSeconds) - ts) > windowSeconds) return { ok: false, code: "WEBHOOK_REPLAY_WINDOW" };
  return { ok: true };
}
