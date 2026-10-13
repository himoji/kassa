import { jcsHash, PairCompleteRequest, PairCompleteResponse, PairStartRequest, PairStartResponse, sha256Base64url } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { getDb } from "../../db/client.ts";
import { devices, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { audit, auditAssertionFailure } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { putGated, takeGated } from "./challenges.ts";
import { requireUser, sessionBody, startSession, userIdOf } from "./session.ts";

/*
 * KassaLite pairing (a native build signed with a free Apple ID: no passkeys, no associated domains).
 *
 * POST /auth/pair/start (full session; 428 PASSKEY_REQUIRED first, then the passkey assertion) → an 8-character code
 * from an unambiguous alphabet (31^8 ≈ 8.5e11), valid 2 minutes, single use, rate limited per IP.
 * POST /auth/pair/complete (public) redeems it for a native session with `scope: "lite"` (refresh keeps the scope) and
 * an iOS Shortcut device token. A lite session never gets passkey-gated rights (session.ts LITE_DENIED → 428 with a
 * link to approve in the web app). Codes live in memory (single process), like WebAuthn challenges.
 */

export const PAIR_TTL_MS = 2 * 60_000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type PendingPair = { userId: string; expiresAtMs: number };
const codes = new Map<string, PendingPair>();

function sweep(): void {
  const now = clock.nowMs();
  for (const [k, v] of codes) if (v.expiresAtMs < now) codes.delete(k);
}

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

function newCode(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

/** Single use: a code is deleted on the first attempt to redeem it, valid or not. */
export function takePairCode(raw: string): PendingPair | null {
  sweep();
  const code = normalizeCode(raw);
  const v = codes.get(code);
  if (!v) return null;
  codes.delete(code);
  return v.expiresAtMs < clock.nowMs() ? null : v;
}

/** The HTTPS origin KassaLite and the Shortcut should use (PHONE_HOST when set: it survives restarts). */
function serverUrl(): string {
  const e = env();
  return e.PHONE_HOST ? `https://${e.PHONE_HOST}` : e.PUBLIC_ORIGIN;
}

const pairRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/auth/pair/start",
    { preHandler: requireUser, schema: { body: PairStartRequest.optional(), response: { 200: PairStartResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const db = getDb();
      const body = req.body ?? {};
      if (!body.challengeId || !body.assertion) {
        const core = { v: 1, kind: "PAIR_KASSALITE", userId, nonce: randomBytes(16).toString("base64url") };
        const hash = jcsHash(core);
        const challengeId = putGated({ userId, purpose: "pair", hash, payload: core });
        throw new HttpProblem(428, "PASSKEY_REQUIRED", "Pairing KassaLite needs your passkey", {
          reasonCodes: ["PASSKEY_REQUIRED"],
          details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
        });
      }
      const gated = takeGated(body.challengeId, userId, "pair");
      if (!gated) throw new HttpProblem(409, "CHALLENGE_MISMATCH", "The pairing request expired; start again");
      const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID", updateCounter: true });
      if (!check.ok) {
        await auditAssertionFailure(userId, "pair", check.reason);
        throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
      }
      sweep();
      let code = newCode();
      while (codes.has(code)) code = newCode();
      const expiresAtMs = clock.nowMs() + PAIR_TTL_MS;
      codes.set(code, { userId, expiresAtMs });
      await audit("DEVICE_PAIRING_STARTED", { userId });
      const server = serverUrl();
      return { code, expiresAt: new Date(expiresAtMs).toISOString(), pairUrl: `kassalite://pair?code=${code}&server=${encodeURIComponent(server)}` };
    },
  );

  app.post("/auth/pair/complete", { schema: { body: PairCompleteRequest, response: { 200: PairCompleteResponse } } }, async (req, reply) => {
    const pending = takePairCode(req.body.code);
    if (!pending) {
      await audit("DEVICE_PAIRING_FAILED", { userId: null, reasonCodes: ["PAIR_CODE_INVALID"] });
      throw new HttpProblem(401, "PAIR_CODE_INVALID", "The code is wrong, used or expired. Create a new one in Settings → Pair KassaLite.");
    }
    const { userId } = pending;
    // Same account check as login: an erased account cannot pair.
    const u = (await getDb().select({ erasedAt: users.erasedAt }).from(users).where(eq(users.id, userId)))[0];
    if (!u || u.erasedAt) throw new HttpProblem(401, "ACCOUNT_ERASED", "This account was erased", { reasonCodes: ["ACCOUNT_ERASED"] });
    const shortcutToken = `ksc_${randomBytes(32).toString("base64url")}`;
    const row = (await getDb().insert(devices).values({ userId, kind: "IOS_SHORTCUT", tokenHash: sha256Base64url(shortcutToken), platform: "kassalite" }).returning({ id: devices.id }))[0]!;
    await ledger.append("DEVICE_TOKEN_CREATED", { userId, deviceId: row.id, kind: "IOS_SHORTCUT" });
    await audit("DEVICE_PAIRED", { userId, deviceId: row.id });
    const tokens = await startSession(reply, userId, "native", { scope: "lite" });
    return { ...(await sessionBody(userId, tokens)), shortcutToken, deviceId: row.id, serverUrl: serverUrl() };
  });
};

export default pairRoutes;
