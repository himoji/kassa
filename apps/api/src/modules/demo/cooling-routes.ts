/*
 * POST /demo/cooling: the demo switch for the 24 h waits (demo/cooling.ts). Registered only when DEMO_ENABLED.
 * Turning the waits off is a loosening: it needs the user's passkey over a fresh core (428 round trip, like backup
 * codes) and is logged with the credential that signed it. Turning them on is a tightening: no passkey, logged too.
 */
import { DemoCoolingRequest, DemoCoolingResponse, jcsHash } from "@kassa/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { demoCoolingOff } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { auditAssertionFailure } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";

async function stateOf(userId: string): Promise<DemoCoolingResponse> {
  const row = (await getDb().select().from(demoCoolingOff).where(eq(demoCoolingOff.userId, userId)))[0];
  return { coolingOn: !row, offAt: row?.offAt.toISOString() ?? null };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/demo/cooling",
    { preHandler: requireUser, schema: { body: DemoCoolingRequest, response: { 200: DemoCoolingResponse } } },
    async (req) => {
      if (!env().DEMO_ENABLED) throw new HttpProblem(404, "NOT_FOUND", "Demo mode is disabled");
      const userId = userIdOf(req);
      const db = getDb();
      if (req.body.enabled) {
        const removed = await db.delete(demoCoolingOff).where(eq(demoCoolingOff.userId, userId)).returning({ userId: demoCoolingOff.userId });
        if (removed.length > 0) await ledger.append("DEMO_COOLING_ON", { userId });
        return stateOf(userId);
      }
      if (!req.body.challengeId || !req.body.assertion) {
        const core = { v: 1, kind: "DEMO_COOLING_OFF", userId, nonce: randomBytes(16).toString("base64url") };
        const hash = jcsHash(core);
        const challengeId = await putGated({ userId, purpose: "demo-cooling", hash, payload: core });
        throw new HttpProblem(428, "PASSKEY_REQUIRED", "Turning the 24 h waits off needs your passkey", {
          reasonCodes: ["PASSKEY_REQUIRED"],
          details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
        });
      }
      const gated = await takeGated(req.body.challengeId, userId, "demo-cooling");
      if (!gated) throw new HttpProblem(409, "CHALLENGE_MISMATCH", "The signed request expired; start again");
      const check = await verifyRulesAssertion(db, { userId, assertion: req.body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
      if (!check.ok) {
        await auditAssertionFailure(userId, "demo-cooling", check.reason);
        throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
      }
      const offAt = clock.now();
      await db.transaction(async (tx) => {
        await tx
          .insert(demoCoolingOff)
          .values({ userId, credentialId: check.credentialId, offAt })
          .onConflictDoUpdate({ target: demoCoolingOff.userId, set: { credentialId: check.credentialId, offAt } });
        await ledger.append("DEMO_COOLING_OFF", { userId, credentialId: check.credentialId }, tx);
      });
      return stateOf(userId);
    },
  );
};

export default routes;
