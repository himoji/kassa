/*
 * Single-use, server-side challenge stores (5-minute TTL on the Clock):
 * - register/login challenges (W3C WebAuthn L3 §13.4.3: random ≥16 bytes, verified once);
 * - passkey-gated writes (PasskeyChallenge in @kassa/shared): the challenge is the hash of the exact
 *   server-built change (settings loosening, base rules), keyed by an opaque challengeId.
 * Honest limit: in-memory, single API process; multi-instance would move this to Postgres.
 */
import { randomBytes } from "node:crypto";

import { clock, MINUTE_MS } from "../clock/index.ts";

export const CHALLENGE_TTL_MS = 5 * MINUTE_MS;

export type PendingChallenge =
  | { purpose: "register"; userId: string; displayName: string; existingUser: boolean; challenge: string; expiresAtMs: number }
  | { purpose: "login"; challenge: string; expiresAtMs: number }
  | { purpose: "recover"; userId: string; codeId: string; challenge: string; expiresAtMs: number };

type NewChallenge =
  | { purpose: "register"; userId: string; displayName: string; existingUser: boolean }
  | { purpose: "login" }
  | { purpose: "recover"; userId: string; codeId: string };

const store = new Map<string, PendingChallenge>();

function sweep(): void {
  const now = clock.nowMs();
  for (const [k, v] of store) if (v.expiresAtMs < now) store.delete(k);
  for (const [k, v] of gated) if (v.expiresAtMs < now) gated.delete(k);
}

/** Store a register/login challenge; the challengeId is the challenge itself (already random). */
export function putChallenge(challenge: string, entry: NewChallenge): string {
  sweep();
  store.set(challenge, { ...entry, challenge, expiresAtMs: clock.nowMs() + CHALLENGE_TTL_MS });
  return challenge;
}

/** Removes and returns the challenge (single use). */
export function takeChallenge(challengeId: string): PendingChallenge | null {
  const v = store.get(challengeId);
  if (!v) return null;
  store.delete(challengeId);
  if (v.expiresAtMs < clock.nowMs()) return null;
  return v;
}

/** challenge from a WebAuthn response's clientDataJSON (base64url JSON, W3C WebAuthn L3 §5.8.1). */
export function challengeOf(response: { response: { clientDataJSON: string } }): string | null {
  try {
    const cd = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    return typeof cd.challenge === "string" ? cd.challenge : null;
  } catch {
    return null;
  }
}

// ---------- passkey-gated writes ----------

export type GatedChallenge = {
  userId: string;
  purpose: string;
  /** The WebAuthn challenge = hash of `payload` (base64url sha256 of JCS). */
  hash: string;
  payload: unknown;
  expiresAtMs: number;
};

const gated = new Map<string, GatedChallenge>();

export function putGated(entry: Omit<GatedChallenge, "expiresAtMs">): string {
  sweep();
  const id = randomBytes(16).toString("base64url");
  gated.set(id, { ...entry, expiresAtMs: clock.nowMs() + CHALLENGE_TTL_MS });
  return id;
}

/** Single use; returns null if unknown, expired, or for another user/purpose. */
export function takeGated(challengeId: string, userId: string, purpose: string): GatedChallenge | null {
  const v = gated.get(challengeId);
  if (!v) return null;
  gated.delete(challengeId);
  if (v.expiresAtMs < clock.nowMs() || v.userId !== userId || v.purpose !== purpose) return null;
  return v;
}
