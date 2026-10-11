/*
 * Unfreeze (docs/DECISIONS.md 2026-10-11: freeze is instant, unfreeze is a loosening — I8).
 *
 * POST /unfreeze: the first call answers HTTP 428 PASSKEY_REQUIRED with a challenge = jcsHash(core), where
 * core = {v, kind:"UNFREEZE", userId, frozenAt, nonce} (the nonce makes every request's challenge unique, so an
 * old assertion can never be replayed). The signed request becomes a rule_changes row (kind UNFREEZE,
 * direction LOOSEN, effectiveAt = now + 24 h on the demo clock); the scheduler lifts the freeze (and an
 * Art. 18 restriction) when it is due. A new freeze or restriction cancels pending unfreezes (tightening
 * wins). Erased accounts can never be unfrozen.
 */
import { jcsHash } from "@kassa/shared";
import { and, eq, isNull, lte } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { ruleChanges, users } from "../../db/schema.ts";
import { audit, auditAssertionFailure } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { addMs, clock } from "../clock/index.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { LOOSEN_DELAY_MS } from "./settings.ts";

export type UnfreezeCore = { v: 1; kind: "UNFREEZE"; userId: string; frozenAt: string; nonce: string };

/** Pending (signed, not applied, not cancelled) unfreeze of a user. */
async function pendingUnfreeze(db: DbOrTx, userId: string) {
  return (
    await db
      .select()
      .from(ruleChanges)
      .where(and(eq(ruleChanges.userId, userId), eq(ruleChanges.kind, "UNFREEZE"), isNull(ruleChanges.appliedAt), isNull(ruleChanges.canceledAt)))
  )[0];
}

export async function requestUnfreeze(
  userId: string,
  body: { challengeId?: string | undefined; assertion?: unknown },
): Promise<{ ruleChangeId: string; effectiveAt: string }> {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  if (u.erasedAt) throw new HttpProblem(409, "ACCOUNT_ERASED", "This account was erased", { reasonCodes: ["ACCOUNT_ERASED"] });
  if (!u.frozenAt) throw new HttpProblem(409, "NOT_FROZEN", "Payments are not frozen");
  const pending = await pendingUnfreeze(db, userId);
  if (pending) {
    throw new HttpProblem(409, "UNFREEZE_PENDING", "An unfreeze is already pending", {
      reasonCodes: ["UNFREEZE_PENDING"],
      details: { ruleChangeId: pending.id, effectiveAt: pending.effectiveAt?.toISOString() ?? null },
    });
  }

  if (!body.challengeId || !body.assertion) {
    const core: UnfreezeCore = { v: 1, kind: "UNFREEZE", userId, frozenAt: u.frozenAt.toISOString(), nonce: randomBytes(16).toString("base64url") };
    const hash = jcsHash(core);
    const challengeId = putGated({ userId, purpose: "unfreeze", hash, payload: core });
    throw new HttpProblem(428, "PASSKEY_REQUIRED", "Unfreezing needs your passkey and takes effect after 24 hours", {
      reasonCodes: ["PASSKEY_REQUIRED", "UNFREEZE_PENDING"],
      details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
    });
  }
  const gated = takeGated(body.challengeId, userId, "unfreeze");
  const core = gated?.payload as UnfreezeCore | undefined;
  // The account must still be frozen by the same freeze the user signed for.
  if (!gated || !core || core.frozenAt !== u.frozenAt.toISOString()) {
    throw new HttpProblem(409, "CHALLENGE_MISMATCH", "The signed request no longer matches; start again");
  }
  const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
  if (!check.ok) {
    await auditAssertionFailure(userId, "unfreeze", check.reason);
    throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
  }

  const now = clock.now();
  const effectiveAt = addMs(now, LOOSEN_DELAY_MS);
  const id = await db.transaction(async (tx) => {
    const row = await tx
      .insert(ruleChanges)
      .values({
        userId,
        kind: "UNFREEZE",
        before: { frozenAt: core.frozenAt, restrictedAt: u.restrictedAt?.toISOString() ?? null },
        after: { frozenAt: null, restrictedAt: null },
        direction: "LOOSEN",
        assertion: body.assertion as never,
        changeHash: gated.hash,
        effectiveAt,
        createdAt: now,
      })
      .returning({ id: ruleChanges.id });
    await audit("UNFREEZE_REQUESTED", { userId, ruleChangeId: row[0]!.id, changeHash: gated.hash, effectiveAt: effectiveAt.toISOString(), credentialId: check.credentialId }, tx);
    return row[0]!.id;
  });
  return { ruleChangeId: id, effectiveAt: effectiveAt.toISOString() };
}

/** Freeze / restriction: cancel pending unfreezes (tightening is instant and wins). */
export async function cancelPendingUnfreezes(tx: DbOrTx, userId: string): Promise<void> {
  await tx
    .update(ruleChanges)
    .set({ canceledAt: clock.now() })
    .where(and(eq(ruleChanges.userId, userId), eq(ruleChanges.kind, "UNFREEZE"), isNull(ruleChanges.appliedAt), isNull(ruleChanges.canceledAt)));
}

/** Scheduler: lift freezes whose signed unfreeze reached effectiveAt. */
export async function applyDueUnfreezes(): Promise<number> {
  const db = getDb();
  const now = clock.now();
  const due = await db
    .select()
    .from(ruleChanges)
    .where(and(eq(ruleChanges.kind, "UNFREEZE"), eq(ruleChanges.direction, "LOOSEN"), isNull(ruleChanges.appliedAt), isNull(ruleChanges.canceledAt), lte(ruleChanges.effectiveAt, now)));
  let applied = 0;
  for (const rc of due) {
    if (!rc.assertion) continue; // never apply an unsigned loosening (I8)
    await db.transaction(async (tx) => {
      const u = (await tx.select().from(users).where(eq(users.id, rc.userId)))[0];
      const before = rc.before as { frozenAt: string };
      if (!u || u.erasedAt || !u.frozenAt || u.frozenAt.toISOString() !== before.frozenAt) {
        // Re-frozen, already unfrozen or erased since the request: the signed change no longer applies.
        await tx.update(ruleChanges).set({ canceledAt: now }).where(eq(ruleChanges.id, rc.id));
        return;
      }
      await tx.update(users).set({ frozenAt: null, restrictedAt: null }).where(eq(users.id, rc.userId));
      await tx.update(ruleChanges).set({ appliedAt: now }).where(eq(ruleChanges.id, rc.id));
      await audit("ACCOUNT_UNFROZEN", { userId: rc.userId, ruleChangeId: rc.id }, tx);
      applied++;
    });
  }
  return applied;
}
