/*
 * Single-use, server-side challenge stores (5-minute TTL on the Clock):
 * - register/login challenges (W3C WebAuthn L3 §13.4.3: random ≥16 bytes, verified once);
 * - passkey-gated writes (PasskeyChallenge in @kassa/shared): the challenge is the hash of the exact
 *   server-built change (settings loosening, base rules), keyed by an opaque challengeId.
 * Stored in Postgres (webauthn_challenges, gated_challenges), not process memory: on Vercel the request that creates a
 * challenge and the one that answers it can land on different function instances. Taking one is a single
 * `DELETE ... RETURNING`, so of two concurrent takes at most one gets the row; expiry is checked on the Clock (demo
 * offset included) for both write and read, and expired rows are swept on each insert.
 */
import { eq, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { gatedChallenges, webauthnChallenges } from "../../db/schema.ts";
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

/** Drop expired rows of both stores (opportunistic, on insert). */
async function sweep(nowMs: number): Promise<void> {
  const db = getDb();
  const now = new Date(nowMs);
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));
  await db.delete(gatedChallenges).where(lt(gatedChallenges.expiresAt, now));
}

/** Store a register/login challenge; the challengeId is the challenge itself (already random). */
export async function putChallenge(challenge: string, entry: NewChallenge): Promise<string> {
  const nowMs = clock.nowMs();
  await sweep(nowMs);
  const { purpose, ...data } = entry;
  const row = { purpose, data, expiresAt: new Date(nowMs + CHALLENGE_TTL_MS) };
  await getDb()
    .insert(webauthnChallenges)
    .values({ challenge, ...row })
    .onConflictDoUpdate({ target: webauthnChallenges.challenge, set: row });
  return challenge;
}

/** Removes and returns the challenge (single use: atomic DELETE ... RETURNING, so only one taker wins). */
export async function takeChallenge(challengeId: string): Promise<PendingChallenge | null> {
  const v = (await getDb().delete(webauthnChallenges).where(eq(webauthnChallenges.challenge, challengeId)).returning())[0];
  if (!v) return null;
  const expiresAtMs = v.expiresAt.getTime();
  if (expiresAtMs < clock.nowMs()) return null;
  return { ...v.data, purpose: v.purpose, challenge: v.challenge, expiresAtMs } as PendingChallenge;
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

export async function putGated(entry: Omit<GatedChallenge, "expiresAtMs">): Promise<string> {
  const nowMs = clock.nowMs();
  await sweep(nowMs);
  const id = randomBytes(16).toString("base64url");
  await getDb()
    .insert(gatedChallenges)
    .values({ id, userId: entry.userId, purpose: entry.purpose, hash: entry.hash, payload: entry.payload, expiresAt: new Date(nowMs + CHALLENGE_TTL_MS) });
  return id;
}

/**
 * Single use (atomic DELETE ... RETURNING; the row is consumed by any attempt, as before); returns null if unknown,
 * expired, or for another user/purpose.
 */
export async function takeGated(challengeId: string, userId: string, purpose: string): Promise<GatedChallenge | null> {
  const v = (await getDb().delete(gatedChallenges).where(eq(gatedChallenges.id, challengeId)).returning())[0];
  if (!v) return null;
  const expiresAtMs = v.expiresAt.getTime();
  if (expiresAtMs < clock.nowMs() || v.userId !== userId || v.purpose !== purpose) return null;
  return { userId: v.userId, purpose: v.purpose, hash: v.hash, payload: v.payload, expiresAtMs };
}
