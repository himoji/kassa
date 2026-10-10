import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

/*
 * Pure-JS hashing so the same code runs in Node/Bun, the browser and Hermes (no `crypto`,
 * no `Buffer`). JCS = RFC 8785 JSON Canonicalization Scheme via `canonicalize`.
 */

/**
 * `canonicalize` rejects lone surrogates through `String.prototype.isWellFormed` (ES2024).
 * Older engines (possibly Hermes) lack it; install the spec behaviour only when absent.
 */
function ensureIsWellFormed(): void {
  const proto = String.prototype as { isWellFormed?: () => boolean };
  if (typeof proto.isWellFormed === "function") return;
  Object.defineProperty(String.prototype, "isWellFormed", {
    configurable: true,
    writable: true,
    value: function isWellFormed(this: string): boolean {
      const s = String(this);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return false;
        }
      }
      return true;
    },
  });
}

/** RFC 8785 canonical JSON. Throws on values JSON cannot represent (undefined root, NaN, cycles, lone surrogates). */
export function jcs(value: unknown): string {
  ensureIsWellFormed();
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError("jcs: value is not JSON-serialisable");
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** base64url(sha256(utf8(text))) — or of raw bytes. */
export function sha256Base64url(input: string | Uint8Array): string {
  return base64url(sha256(typeof input === "string" ? utf8ToBytes(input) : input));
}

/** base64url(sha256(utf8(JCS(value)))). */
export function jcsHash(value: unknown): string {
  return sha256Base64url(jcs(value));
}
