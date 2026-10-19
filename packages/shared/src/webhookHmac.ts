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

/*
 * Kassa API → mock world requests (deployed builds lock the mock world's control routes, apps/mock-world/src/access.ts):
 *   X-Kassa-Request-Auth: t=<unix seconds>,s=<hex(HMAC-SHA256(MOCK_HMAC_SECRET, "kassa-request:v1\n<t>\n<METHOD>\n<path>\n<body>"))>
 * `path` is the request target as received (with the /mock prefix and the query string); `body` is the JSON text sent
 * (JSON.stringify of the payload, "" without a body). The domain prefix keeps these signatures apart from webhook
 * signatures (`<t>.<body>`), so neither can be replayed as the other. Same 5-minute window, real (wall) time.
 */
export const MOCK_REQUEST_AUTH_HEADER = "x-kassa-request-auth";

function requestMac(secret: string, timestamp: number, method: string, path: string, body: string): string {
  if (!secret) throw new Error("mockRequestAuth: empty secret");
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`kassa-request:v1\n${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`)));
}

/** The X-Kassa-Request-Auth value for one request. */
export function mockRequestAuth(secret: string, method: string, path: string, body: string, nowSeconds: number): string {
  const ts = Math.floor(nowSeconds);
  return `t=${ts},s=${requestMac(secret, ts, method, path, body)}`;
}

/** True when `header` is a valid X-Kassa-Request-Auth for this method, path and body inside the window. */
export function verifyMockRequestAuth(
  secret: string,
  header: string | undefined,
  method: string,
  path: string,
  body: string,
  nowSeconds: number,
  windowSeconds: number = MOCK_WEBHOOK_WINDOW_SECONDS,
): boolean {
  const m = /^t=(\d{1,12}),s=([0-9a-f]{64})$/.exec(header?.trim() ?? "");
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(Math.floor(nowSeconds) - ts) > windowSeconds) return false;
  return timingSafeEqualHex(requestMac(secret, ts, method, path, body), m[2]!);
}

/*
 * (added 2026-10-19) Signing in to a school portal from Kassa. The portal link on a tuition recipient added from the
 * school directory (apps/api/src/modules/schools/portal.ts) carries
 *   access=<exp>.<hex(HMAC-SHA256(MOCK_HMAC_SECRET, "school-portal:v1\n<exp>\n<schoolId>\n<studentId>"))>
 * so the student who opens it from the app sees that student's invoices until <exp> (unix seconds, wall time) without
 * typing their date of birth again. Its own domain prefix: never valid as a request or webhook signature.
 */
function portalMac(secret: string, expSeconds: number, schoolId: string, studentId: string): string {
  if (!secret) throw new Error("schoolPortalAccess: empty secret");
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`school-portal:v1\n${expSeconds}\n${schoolId.toLowerCase()}\n${studentId.toUpperCase()}`)));
}

/** The `access` value for one student's portal page, valid until `expSeconds`. */
export function schoolPortalAccess(secret: string, schoolId: string, studentId: string, expSeconds: number): string {
  const exp = Math.floor(expSeconds);
  return `${exp}.${portalMac(secret, exp, schoolId, studentId)}`;
}

/** True when `token` is a valid, unexpired `access` value for this school and student. */
export function verifySchoolPortalAccess(secret: string, token: unknown, schoolId: string, studentId: string, nowSeconds: number): boolean {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(typeof token === "string" ? token.trim() : "");
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  if (exp < Math.floor(nowSeconds)) return false;
  return timingSafeEqualHex(portalMac(secret, exp, schoolId, studentId), m[2]!);
}
