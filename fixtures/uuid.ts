import { sha1 } from "@noble/hashes/legacy.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/*
 * Stable fixture ids: RFC 9562 §5.5 UUIDv5 (SHA-1, name-based) in the URL namespace
 * (RFC 9562 Appendix A: 6ba7b811-9dad-11d1-80b4-00c04fd430c8) over
 * `https://kassa.demo/seed/<name>`. Same name -> same id on every run and machine.
 */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
export const SEED_ID_PREFIX = "https://kassa.demo/seed/";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function uuidV5(name: string, namespace: string = NAMESPACE_URL): string {
  const ns = hexToBytes(namespace.replace(/-/g, ""));
  const nameBytes = utf8ToBytes(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  const h = sha1(input).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // variant 10xx (RFC 9562 §4.1)
  const x = Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Fixture id for a seed entity name like `payee/landlord`. */
export function seedId(name: string): string {
  return uuidV5(`${SEED_ID_PREFIX}${name}`);
}
