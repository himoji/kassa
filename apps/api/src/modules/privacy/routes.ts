/*
 * Data-subject rights endpoints (GDPR Arts. 7(3), 15, 17, 18, 20) and the AI notice (EU AI Act Art. 50).
 * Art. 16 rectification is PATCH /me (users/routes.ts). Session required (deny by default, http/security.ts),
 * except GET /privacy/ai-notice, which the sign-up screen shows before an account exists.
 */
import {
  AiConsentRequest,
  AiConsentResponse,
  AiNotice,
  EraseRequest,
  EraseResponse,
  jcsHash,
  PrivacyExportResponse,
  RestrictResponse,
} from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { auditAssertionFailure } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { userIdOf } from "../auth/session.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { aiNotice } from "./notice.ts";
import { eraseUser, ERASED, exportUserData, RETAINED, restrictUser, setAiConsent } from "./service.ts";

type EraseCore = { v: 1; kind: "ERASE"; userId: string; nonce: string };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/privacy/ai-notice", { schema: { response: { 200: AiNotice } } }, async () => aiNotice());

  app.get("/privacy/export", { schema: { response: { 200: PrivacyExportResponse } } }, async (req, reply) => {
    const body = await exportUserData(userIdOf(req));
    return reply.header("content-disposition", 'attachment; filename="kassa-data-export.json"').header("cache-control", "no-store").send(body);
  });

  app.post("/privacy/ai-consent", { schema: { body: AiConsentRequest, response: { 200: AiConsentResponse } } }, async (req) => {
    const at = await setAiConsent(userIdOf(req), req.body.consent);
    return { aiConsentAt: at?.toISOString() ?? null };
  });

  app.post("/privacy/restrict", { schema: { response: { 200: RestrictResponse } } }, async (req) => {
    const r = await restrictUser(userIdOf(req));
    return { restrictedAt: r.restrictedAt.toISOString(), frozenAt: r.frozenAt.toISOString() };
  });

  // Irreversible: a fresh passkey assertion over a server-built, single-use challenge (like loosenings, I8).
  app.post("/privacy/erase", { schema: { body: EraseRequest, response: { 200: EraseResponse } } }, async (req) => {
    const userId = userIdOf(req);
    const db = getDb();
    if (!req.body.challengeId || !req.body.assertion) {
      const core: EraseCore = { v: 1, kind: "ERASE", userId, nonce: randomBytes(16).toString("base64url") };
      const hash = jcsHash(core);
      const challengeId = putGated({ userId, purpose: "erase", hash, payload: core });
      throw new HttpProblem(428, "PASSKEY_REQUIRED", "Erasing your data needs your passkey", {
        reasonCodes: ["PASSKEY_REQUIRED"],
        details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
      });
    }
    const gated = takeGated(req.body.challengeId, userId, "erase");
    if (!gated) throw new HttpProblem(409, "CHALLENGE_MISMATCH", "Erase challenge unknown or expired; start again");
    const check = await verifyRulesAssertion(db, { userId, assertion: req.body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
    if (!check.ok) {
      await auditAssertionFailure(userId, "erase", check.reason);
      throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
    }
    const { erasedAt } = await eraseUser(userId);
    return { erasedAt: erasedAt.toISOString(), erased: ERASED, retained: RETAINED };
  });
};

export default routes;
