/*
 * Backup codes (account recovery when every passkey is lost).
 *
 * - GET  /auth/recovery-codes          → how many unused codes are left.
 * - POST /auth/recovery-codes          → a new set of RECOVERY_CODE_COUNT codes, shown once; the old set stops working.
 *   Minting a credential is passkey-gated: HTTP 428 PASSKEY_REQUIRED with a challenge over a fresh nonce, like
 *   POST /unfreeze, so a stolen session alone cannot create codes.
 * - POST /auth/recovery/options {code} → WebAuthn registration options for the code's account (public route).
 * - POST /auth/recovery/verify         → the code is spent (single use, atomic), the new passkey REPLACES every old
 *   one (a lost device is not trusted any more), sessions issued before now are refused, and payments are frozen
 *   (a tightening, I8): moving money again needs the new passkey plus the usual 24 h unfreeze wait. Ledger entries
 *   record each step (I12).
 *
 * Codes: 10 characters from Crockford's base32 alphabet (50 bits), shown as XXXXX-XXXXX. Only HMAC-SHA256(code)
 * keyed with SESSION_SECRET is stored. Guessing is bounded by the auth rate limit (RATE_LIMIT_AUTH_PER_MIN).
 */
import {
  RecoveryCodesGenerateRequest,
  RecoveryCodesResponse,
  RecoveryCodesStatus,
  RecoveryOptionsRequest,
  RecoveryVerifyRequest,
  RecoveryVerifyResponse,
  RegisterOptionsResponse,
  jcsHash,
} from "@kassa/shared";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { recoveryCodes, users, webauthnCredentialsRules } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { audit, auditAssertionFailure } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { registerPaymentsCredential, removePaymentsCredentials } from "../payments/credentials.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { cancelPendingUnfreezes } from "../users/unfreeze.ts";
import { putChallenge, putGated, takeChallenge, takeGated } from "./challenges.ts";
import { requireUser, sessionBody, startSession, userIdOf } from "./session.ts";

export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32: no I, L, O, U (nothing to misread). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newRecoveryCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Upper-case, no separators or spaces, and the letters people confuse with digits mapped as Crockford does. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** The digest key: derived from SESSION_SECRET with HKDF (RFC 5869) for this purpose only, never the signing key itself. */
function recoveryKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", env().SESSION_SECRET, "kassa", "recovery-codes-v2", 32));
}

export function hashRecoveryCode(code: string): string {
  return createHmac("sha256", recoveryKey()).update(`kassa-recovery-v2:${normalizeRecoveryCode(code)}`).digest("base64url");
}

/** Codes saved before 2026-10-14 were keyed with SESSION_SECRET directly; they still redeem until replaced. */
function legacyHashRecoveryCode(code: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(`kassa-recovery-v1:${normalizeRecoveryCode(code)}`).digest("base64url");
}

async function status(userId: string): Promise<RecoveryCodesStatus> {
  const rows = await getDb().select({ usedAt: recoveryCodes.usedAt, createdAt: recoveryCodes.createdAt }).from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  const createdAt = rows.reduce<Date | null>((a, r) => (!a || r.createdAt > a ? r.createdAt : a), null);
  return { remaining: rows.filter((r) => !r.usedAt).length, total: rows.length, createdAt: createdAt?.toISOString() ?? null };
}

type CodesCore = { v: 1; kind: "RECOVERY_CODES"; userId: string; nonce: string };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/auth/recovery-codes", { preHandler: requireUser, schema: { response: { 200: RecoveryCodesStatus } } }, async (req) => status(userIdOf(req)));

  app.post(
    "/auth/recovery-codes",
    { preHandler: requireUser, schema: { body: RecoveryCodesGenerateRequest, response: { 200: RecoveryCodesResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const db = getDb();
      if (!req.body.challengeId || !req.body.assertion) {
        const core: CodesCore = { v: 1, kind: "RECOVERY_CODES", userId, nonce: randomBytes(16).toString("base64url") };
        const hash = jcsHash(core);
        const challengeId = await putGated({ userId, purpose: "recovery-codes", hash, payload: core });
        throw new HttpProblem(428, "PASSKEY_REQUIRED", "Creating backup codes needs your passkey", {
          reasonCodes: ["PASSKEY_REQUIRED"],
          details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
        });
      }
      const gated = await takeGated(req.body.challengeId, userId, "recovery-codes");
      if (!gated) throw new HttpProblem(409, "CHALLENGE_MISMATCH", "The signed request expired; start again");
      const check = await verifyRulesAssertion(db, { userId, assertion: req.body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
      if (!check.ok) {
        await auditAssertionFailure(userId, "recovery-codes", check.reason);
        throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
      }
      const now = clock.now();
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      await db.transaction(async (tx) => {
        await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
        await tx.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c), createdAt: now })));
        await ledger.append("RECOVERY_CODES_CREATED", { userId, count: codes.length, credentialId: check.credentialId }, tx);
      });
      return { codes, createdAt: now.toISOString() };
    },
  );

  app.post("/auth/recovery/options", { schema: { body: RecoveryOptionsRequest, response: { 200: RegisterOptionsResponse } } }, async (req) => {
    const db = getDb();
    const row = (
      await db
        .select({ id: recoveryCodes.id, userId: recoveryCodes.userId, displayName: users.displayName, erasedAt: users.erasedAt })
        .from(recoveryCodes)
        .innerJoin(users, eq(users.id, recoveryCodes.userId))
        .where(and(inArray(recoveryCodes.codeHash, [hashRecoveryCode(req.body.code), legacyHashRecoveryCode(req.body.code)]), isNull(recoveryCodes.usedAt)))
    )[0];
    if (!row || row.erasedAt) {
      await audit("AUTH_RECOVERY_FAILED", { userId: null, reasonCodes: ["ASSERTION_INVALID"], detail: "unknown or used backup code" });
      throw new HttpProblem(401, "RECOVERY_CODE_INVALID", "This backup code is not valid or was already used");
    }
    const e = env();
    const options = await generateRegistrationOptions({
      rpName: e.RP_NAME,
      rpID: e.RP_ID,
      userName: row.displayName,
      userDisplayName: row.displayName,
      userID: new TextEncoder().encode(row.userId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const challengeId = await putChallenge(options.challenge, { purpose: "recover", userId: row.userId, codeId: row.id });
    return { challengeId, options: options as never };
  });

  app.post("/auth/recovery/verify", { schema: { body: RecoveryVerifyRequest, response: { 200: RecoveryVerifyResponse } } }, async (req, reply) => {
    const db = getDb();
    const e = env();
    const pending = await takeChallenge(req.body.challengeId);
    if (!pending || pending.purpose !== "recover") throw new HttpProblem(400, "CHALLENGE_UNKNOWN", "Recovery challenge unknown or expired; enter the code again");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body.response as never,
        expectedChallenge: pending.challenge,
        expectedOrigin: e.origins,
        expectedRPID: e.RP_ID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new HttpProblem(400, "ASSERTION_INVALID", (err as Error).message, { reasonCodes: ["ASSERTION_INVALID"] });
    }
    if (!verification.verified) throw new HttpProblem(400, "ASSERTION_INVALID", "Registration not verified");
    const { credential } = verification.registrationInfo;
    const userId = pending.userId;
    const now = clock.now();

    const result = await db.transaction(async (tx) => {
      // Single use, also against a concurrent recovery with the same code.
      const spent = await tx
        .update(recoveryCodes)
        .set({ usedAt: now })
        .where(and(eq(recoveryCodes.id, pending.codeId), eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
        .returning({ id: recoveryCodes.id });
      if (spent.length === 0) throw new HttpProblem(401, "RECOVERY_CODE_INVALID", "This backup code is not valid or was already used");
      const u = (await tx.select({ erasedAt: users.erasedAt, frozenAt: users.frozenAt }).from(users).where(eq(users.id, userId)))[0];
      if (!u || u.erasedAt) throw new HttpProblem(401, "ACCOUNT_ERASED", "This account was erased", { reasonCodes: ["ACCOUNT_ERASED"] });

      const removed = (await tx.delete(webauthnCredentialsRules).where(eq(webauthnCredentialsRules.userId, userId)).returning({ id: webauthnCredentialsRules.id })).length;
      await removePaymentsCredentials(tx, userId);
      const row = {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? [],
      };
      await tx.insert(webauthnCredentialsRules).values(row);
      await registerPaymentsCredential(tx, row);

      // Freeze payments (instant tightening) and drop any pending unfreeze; sessions from before now stop working.
      await tx.update(users).set({ sessionsRevokedAt: now, ...(u.frozenAt ? {} : { frozenAt: now }) }).where(eq(users.id, userId));
      if (!u.frozenAt) await ledger.append("ACCOUNT_FROZEN", { userId, reason: "ACCOUNT_RECOVERY" }, tx);
      await cancelPendingUnfreezes(tx, userId);

      const left = (await tx.select({ id: recoveryCodes.id }).from(recoveryCodes).where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))).length;
      await ledger.append("AUTH_ACCOUNT_RECOVERED", { userId, credentialId: credential.id, passkeysReplaced: removed, codesLeft: left }, tx);
      return { codesLeft: left };
    });
    const body = await sessionBody(userId, await startSession(reply, userId, req.body.client));
    return { ...body, recovery: { codesLeft: result.codesLeft, paymentsFrozen: true } };
  });
};

export default routes;
