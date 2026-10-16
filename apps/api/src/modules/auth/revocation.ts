/*
 * (R13) Revoked session JWTs by jti, in Postgres (revoked_tokens), not process memory: a restart or a second API
 * instance still refuses a spent refresh token. A row lives until the token's own `exp` (wall time,
 * clock.realNowMs, like every session lifetime); the scheduler then purges it, since the JWT check refuses an
 * expired token by itself. Spending is one `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so of two concurrent uses
 * of the same refresh token at most one wins.
 */
import { eq, lt } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { revokedTokens } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";

export type RevokedKind = "refresh" | "session";

/** Mark a jti as used. Returns false when it already was (a reuse). `expS` = the token's `exp` (seconds). */
export async function spendJti(jti: string, kind: RevokedKind, expS: number): Promise<boolean> {
  const inserted = await getDb()
    .insert(revokedTokens)
    .values({ jti, kind, expiresAt: new Date(expS * 1000) })
    .onConflictDoNothing()
    .returning({ jti: revokedTokens.jti });
  return inserted.length > 0;
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  const rows = await getDb().select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, jti)).limit(1);
  return rows.length > 0;
}

/** Scheduler job: drop rows of tokens past their `exp`. Returns the count. */
export async function purgeRevokedTokens(nowMs: number = clock.realNowMs()): Promise<number> {
  const rows = await getDb()
    .delete(revokedTokens)
    .where(lt(revokedTokens.expiresAt, new Date(nowMs)))
    .returning({ jti: revokedTokens.jti });
  return rows.length;
}
