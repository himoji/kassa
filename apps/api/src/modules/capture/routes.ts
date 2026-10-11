import { CaptureEventRequest, CaptureEventResponse, SettlementEventRequest, SettlementEventResponse, sha256Base64url } from "@kassa/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";

import { getDb } from "../../db/client.ts";
import { devices } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { ShortcutPayload } from "./parsers/index.ts";
import { ingestCapture, reconcileSettlement, SettlementError } from "./service.ts";

/*
 * POST /capture/event (app: notification simulator, text, voice transcript), POST /capture/settlement
 * (statement line / demo), POST /capture/shortcut (iOS Shortcut, per-device bearer token, I13).
 * Triggers never approve (I6): these routes only log spending.
 */

/** I13: `Authorization: Bearer <device token>`; devices.tokenHash = base64url(sha256(token)). */
async function shortcutDeviceUser(req: FastifyRequest): Promise<string> {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new HttpProblem(401, "DEVICE_TOKEN_REQUIRED", "Shortcut device token missing");
  const rows = await getDb()
    .select({ userId: devices.userId })
    .from(devices)
    .where(and(eq(devices.tokenHash, sha256Base64url(token)), eq(devices.kind, "IOS_SHORTCUT"), isNull(devices.revokedAt)));
  const row = rows[0];
  if (!row) throw new HttpProblem(401, "DEVICE_TOKEN_INVALID", "Unknown or revoked device token");
  return row.userId;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/capture/shortcut",
    { schema: { body: ShortcutPayload, response: { 200: CaptureEventResponse } } },
    async (req) => {
      const userId = await shortcutDeviceUser(req);
      return ingestCapture(userId, { source: "SHORTCUT", shortcut: req.body });
    },
  );

  app.post("/capture/event", { preHandler: requireUser, schema: { body: CaptureEventRequest, response: { 200: CaptureEventResponse } } }, async (req) => {
      const userId = userIdOf(req);
      const body = req.body;
      if (body.source === "KASSA_PAYMENT" || body.source === "SETTLEMENT") {
        throw new HttpProblem(400, "CAPTURE_SOURCE_INVALID", `${body.source} events are created by the server (use /capture/settlement for statements)`);
      }
      return "rawText" in body
        ? ingestCapture(userId, { source: body.source, rawText: body.rawText })
        : ingestCapture(userId, { source: body.source, fields: body.fields });
    });

  app.post("/capture/settlement", { preHandler: requireUser, schema: { body: SettlementEventRequest, response: { 200: SettlementEventResponse } } }, async (req) => {
      try {
        return await reconcileSettlement(userIdOf(req), req.body);
      } catch (e) {
        if (e instanceof SettlementError) throw new HttpProblem(e.code === "SETTLEMENT_NO_MATCH" ? 404 : 409, e.code, e.message);
        throw e;
      }
    });
};

export default routes;
