import { CaptureEventRequest, CaptureEventResponse, RecentCapturesResponse, SettlementEventRequest, SettlementEventResponse, sha256Base64url } from "@kassa/shared";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { devices, notifications, payees, transactions } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import { HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { captureNudge } from "./nudge.ts";
import { whereLabel, type PlaceJson } from "./place.ts";
import { ForwardedNotification, ShortcutPayload } from "./parsers/index.ts";
import { ingestCapture, placeName, reconcileSettlement, SettlementError } from "./service.ts";

/*
 * POST /capture/event (app: notification simulator, text, voice transcript), POST /capture/settlement
 * (statement line / demo), POST /capture/shortcut (iOS Shortcut, per-device bearer token, I13), GET /capture/recent
 * (the caller's own latest captures + nudges; KassaLite's Activity tab polls it).
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

/** The Shortcut shows `nudge` (or `nudgeTitle` + `nudgeBody`) as its notification (docs/SHORTCUT_SETUP.md); the rest is the usual capture result. */
const ShortcutCaptureResponse = CaptureEventResponse.extend({ nudge: z.string(), nudgeTitle: z.string(), nudgeBody: z.string() });

function recentPlace(p: PlaceJson): { name?: string; kind?: string; where?: string } {
  const where = whereLabel(p);
  // A name only cleaned from the statement text is named afresh (the merchant field), so cleaning fixes reach old rows.
  const name = p.source === "CLEANED" ? undefined : p.name;
  return { ...(name ? { name } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(where ? { where } : {}) };
}

/** Device-token owner per request (set in onRequest, read by the handler). */
const shortcutUsers = new WeakMap<FastifyRequest, string>();

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/capture/shortcut",
    {
      // Authenticate before the body is parsed or validated (no schema hints to unauthenticated callers).
      onRequest: async (req) => {
        shortcutUsers.set(req, await shortcutDeviceUser(req));
      },
      // The iOS Transaction fields, or a forwarded notification / SMS text (Android wallets, bank SMS for online
      // and in-app Apple Pay): `text` marks the second shape.
      schema: { body: z.union([ForwardedNotification, ShortcutPayload]), response: { 200: ShortcutCaptureResponse } },
    },
    async (req) => {
      const userId = shortcutUsers.get(req);
      if (!userId) throw new HttpProblem(401, "DEVICE_TOKEN_REQUIRED", "Shortcut device token missing");
      const body = req.body;
      const result = await ingestCapture(userId, "text" in body ? { source: "SHORTCUT", forwarded: body } : { source: "SHORTCUT", shortcut: body });
      const n = await captureNudge(userId, result);
      return { ...result, nudge: n.nudge, nudgeTitle: n.title, nudgeBody: n.body };
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

  app.get(
    "/capture/recent",
    { preHandler: requireUser, schema: { querystring: z.object({ since: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), response: { 200: RecentCapturesResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const { since, limit } = req.query;
      const after = since ? new Date(since) : null;
      const db = getDb();
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.source, ["SHORTCUT", "NOTIF_SIM", "TEXT", "VOICE", "SCREENSHOT"]),
            isNull(transactions.mergedIntoId),
            after ? gt(transactions.createdAt, after) : undefined,
          ),
        )
        .orderBy(desc(transactions.createdAt))
        .limit(limit);
      const nudges = await db
        .select({ id: notifications.id, title: notifications.title, body: notifications.body, createdAt: notifications.createdAt })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), after ? gt(notifications.createdAt, after) : undefined))
        .orderBy(desc(notifications.createdAt))
        .limit(20);
      // The name people recognise (as on the purchase screen), not the statement's "SQ *BLUE BOTTLE 0042".
      const own = await db.select({ name: payees.name }).from(payees).where(eq(payees.userId, userId));
      const names = await Promise.all(rows.map(async (t) => (await placeName(userId, t.merchantNorm, t.merchantRaw, db, own)).name));
      return {
        captures: rows.map((t, i) => ({
          id: t.id,
          source: t.source,
          merchant: names[i]!,
          amountMinor: t.amountMinor,
          currency: t.currency,
          homeAmountMinor: t.homeAmountMinor,
          category: t.category,
          occurredAt: t.occurredAt.toISOString(),
          createdAt: t.createdAt.toISOString(),
          ...(t.place ? { place: recentPlace(t.place) } : {}),
        })),
        nudges: nudges.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
        serverTime: clock.now().toISOString(),
      };
    },
  );

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
