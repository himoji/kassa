import { CaptureEventRequest, CaptureEventResponse, RecentCapturesResponse, SettlementEventRequest, SettlementEventResponse, sha256Base64url } from "@kassa/shared";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { devices, notifications, payees, SHORTCUT_ATTEMPTS_KEPT, transactions, type ShortcutAttemptJson, type ShortcutCheckJson } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import { HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { isAiConfigError } from "../ai/errors.ts";
import { currentAgentMode } from "../ai/mode.ts";
import { MAX_VOICE_BYTES, transcribeAudio, VOICE_FORMATS, VoiceError } from "../ai/voice.ts";
import { claimConversation } from "../agent/history.ts";
import { startTurn } from "../agent/loop.ts";
import { dbPorts } from "../agent/ports.ts";
import { dbTurnStore } from "../agent/store.ts";
import { assertAiProcessingAllowed } from "../privacy/notice.ts";
import { captureNudge } from "./nudge.ts";
import { PlaceHint, whereLabel, type PlaceJson } from "./place.ts";
import { ForwardedNotification, ShortcutPayload } from "./parsers/index.ts";
import { ingestCapture, placeName, reconcileSettlement, SettlementError } from "./service.ts";

/*
 * POST /capture/event (app: notification simulator, text, voice transcript), POST /capture/settlement
 * (statement line / demo), POST /capture/shortcut (iOS Shortcut, per-device bearer token, I13), GET /capture/recent
 * (the caller's own latest captures + nudges; KassaLite's Activity tab polls it).
 * Triggers never approve (I6): these routes only log spending.
 */

/** The User-Agent's first product ("BackgroundShortcutRunner/1.0 CFNetwork/…" → "BackgroundShortcutRunner"), so the
 * live Shortcut test can tell the iOS Shortcuts app from a browser or a script. */
function clientOf(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  const m = typeof ua === "string" ? /^[A-Za-z0-9._-]{1,40}/.exec(ua.trim()) : null;
  return m ? m[0] : null;
}

const NO_FIELDS: ShortcutAttemptJson["fields"] = { merchant: false, amount: false, card: false, place: false };

/** Add one request to the token's recent list (newest first, SHORTCUT_ATTEMPTS_KEPT kept); an accepted one also updates the last check. */
async function recordAttempt(deviceId: string, attempt: ShortcutAttemptJson, lastCheck?: ShortcutCheckJson): Promise<void> {
  const db = getDb();
  const row = (await db.select({ recent: devices.recentChecks }).from(devices).where(eq(devices.id, deviceId)))[0];
  const recentChecks = [attempt, ...(row?.recent ?? [])].slice(0, SHORTCUT_ATTEMPTS_KEPT);
  const at = new Date(attempt.at);
  await db
    .update(devices)
    // Only a request Kassa accepted counts as "used": KassaLite reads a moving lastUsedAt as "the Shortcut is connected".
    .set(lastCheck ? { recentChecks, lastUsedAt: at, lastCheck } : { recentChecks })
    .where(eq(devices.id, deviceId));
}

/**
 * I13: `Authorization: Bearer <device token>`, or `?key=<device token>` so a hand-built Shortcut needs one pasted URL
 * and no header (the server log redacts `key`, server.ts). devices.tokenHash = base64url(sha256(token)).
 */
async function shortcutDevice(req: FastifyRequest): Promise<{ userId: string; deviceId: string }> {
  const auth = req.headers.authorization;
  const query = req.query as { key?: unknown } | undefined;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : typeof query?.key === "string" ? query.key.trim() : "";
  if (!token) throw new HttpProblem(401, "DEVICE_TOKEN_REQUIRED", "Shortcut device token missing");
  const rows = await getDb()
    .select({ userId: devices.userId, deviceId: devices.id })
    .from(devices)
    .where(and(eq(devices.tokenHash, sha256Base64url(token)), eq(devices.kind, "IOS_SHORTCUT"), isNull(devices.revokedAt)));
  const row = rows[0];
  if (!row) {
    // A revoked token still names its owner: the live test can say "your Shortcut uses an old key". An unknown token
    // names nobody and is not recorded.
    const revoked = (
      await getDb()
        .select({ deviceId: devices.id })
        .from(devices)
        .where(and(eq(devices.tokenHash, sha256Base64url(token)), eq(devices.kind, "IOS_SHORTCUT")))
    )[0];
    if (revoked) {
      const via = req.headers["x-kassa-client"] === "log-payment-action" ? "action" : "shortcut";
      await recordAttempt(revoked.deviceId, { at: clock.now().toISOString(), kind: "REVOKED_KEY", via, client: clientOf(req), fields: NO_FIELDS, status: null, transactionId: null });
    }
    throw new HttpProblem(401, "DEVICE_TOKEN_INVALID", "Unknown or revoked device token");
  }
  return row;
}

/**
 * A body without an amount. Its merchant tells which:
 *  - `{test: true}`: KassaLite checking the server and key itself. Nothing is recorded on the device.
 *  - merchant empty too: the Shortcut or action ran without a Transaction input (by hand, a test). Recorded as TEST.
 *  - a merchant but no amount: a tap reached Kassa through an automation whose Amount is not wired. Recorded as
 *    INCOMPLETE, and the reply says so in the notification instead of a bare 400 the person never sees.
 * Nothing is logged in any of them.
 */
const ShortcutNoAmount = PlaceHint.extend({
  test: z.literal(true).optional(),
  merchant: z.string().max(200).optional(),
  amount: z.literal("").optional(),
  card: z.string().max(200).optional(),
});
const ShortcutNoAmountResponse = z.object({
  status: z.enum(["TEST", "INCOMPLETE"]),
  nudge: z.string(),
  nudgeTitle: z.string(),
  nudgeBody: z.string(),
});
const TEST_TITLE = "Kassa is connected";
const TEST_BODY = "This Shortcut reaches your Kassa server. Your Apple Pay purchases will be logged.";
const INCOMPLETE_TITLE = "Kassa got the tap, but no amount";
const INCOMPLETE_BODY = "Open KassaLite → Settings: in the automation, set Amount to Shortcut Input › Amount.";

const text = (v: unknown): boolean => typeof v === "string" ? v.trim() !== "" : typeof v === "number";

/** Which Transaction fields the request carried (KassaLite's tap check names the missing ones). */
function receivedFields(body: Record<string, unknown>): ShortcutCheckJson["fields"] {
  return {
    merchant: text(body.merchant) || text(body.text),
    amount: text(body.amount) || text(body.text),
    card: text(body.card),
    place: text(body.street) || text(body.city) || text(body.country) || text(body.latitude),
  };
}

/** The Shortcut shows `nudge` (or `nudgeTitle` + `nudgeBody`) as its notification (docs/guide/shortcuts.md); the rest is the usual capture result. */
const ShortcutCaptureResponse = CaptureEventResponse.extend({ nudge: z.string(), nudgeTitle: z.string(), nudgeBody: z.string() });

function recentPlace(p: PlaceJson): { name?: string; kind?: string; where?: string } {
  const where = whereLabel(p);
  // A name only cleaned from the statement text is named afresh (the merchant field), so cleaning fixes reach old rows.
  const name = p.source === "CLEANED" ? undefined : p.name;
  return { ...(name ? { name } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(where ? { where } : {}) };
}

/** Device-token owner per request (set in onRequest, read by the handler). */
const shortcutUsers = new WeakMap<FastifyRequest, { userId: string; deviceId: string }>();

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/capture/shortcut",
    {
      // Authenticate before the body is parsed or validated (no schema hints to unauthenticated callers).
      onRequest: async (req) => {
        shortcutUsers.set(req, await shortcutDevice(req));
      },
      // A known token whose request still failed (a body that is not JSON or lacks the fields, or an error while
      // logging): recorded, so the live test shows why instead of nothing.
      onError: async (req, _reply, error) => {
        const device = shortcutUsers.get(req);
        if (!device) return;
        const status = (error as { statusCode?: number }).statusCode ?? 500;
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
        const contentType = String(req.headers["content-type"] ?? "none").split(";")[0];
        const problem =
          status === 415
            ? `The request body is not JSON (content type ${contentType})`
            : status === 400
              ? `The JSON body has the wrong shape: ${error.message}`.slice(0, 200)
              : `${(error as { code?: string }).code ?? "ERROR"} (HTTP ${status})`;
        await recordAttempt(device.deviceId, {
          at: clock.now().toISOString(),
          kind: status === 400 || status === 415 ? "BAD_BODY" : "FAILED",
          via: req.headers["x-kassa-client"] === "log-payment-action" ? "action" : "shortcut",
          client: clientOf(req),
          fields: body ? receivedFields(body) : NO_FIELDS,
          status: null,
          transactionId: null,
          problem,
        }).catch((err: unknown) => req.log.warn({ err }, "shortcut attempt not recorded"));
      },
      // The iOS Transaction fields, or a forwarded notification / SMS text (Android wallets, bank SMS for online
      // and in-app Apple Pay): `text` marks the second shape. A body without an amount: ShortcutNoAmount.
      schema: {
        body: z.union([ForwardedNotification, ShortcutPayload, ShortcutNoAmount]),
        response: { 200: z.union([ShortcutCaptureResponse, ShortcutNoAmountResponse]) },
      },
    },
    async (req) => {
      const device = shortcutUsers.get(req);
      if (!device) throw new HttpProblem(401, "DEVICE_TOKEN_REQUIRED", "Shortcut device token missing");
      const { userId, deviceId } = device;
      const body = req.body;
      const via = req.headers["x-kassa-client"] === "log-payment-action" ? "action" : "shortcut";
      const record = async (check: Omit<ShortcutCheckJson, "at" | "via" | "fields">, replyTitle: string) => {
        const lastCheck: ShortcutCheckJson = { at: clock.now().toISOString(), via, fields: receivedFields(body as Record<string, unknown>), ...check };
        await recordAttempt(deviceId, { ...lastCheck, client: clientOf(req), replyTitle }, lastCheck);
      };

      if (!("text" in body) && (body.amount === undefined || body.amount === "")) {
        if ("test" in body && body.test) return { status: "TEST" as const, nudge: `${TEST_TITLE}\n${TEST_BODY}`, nudgeTitle: TEST_TITLE, nudgeBody: TEST_BODY };
        if (text(body.merchant)) {
          await record({ kind: "INCOMPLETE", status: null, transactionId: null }, INCOMPLETE_TITLE);
          return { status: "INCOMPLETE" as const, nudge: `${INCOMPLETE_TITLE}\n${INCOMPLETE_BODY}`, nudgeTitle: INCOMPLETE_TITLE, nudgeBody: INCOMPLETE_BODY };
        }
        await record({ kind: "TEST", status: null, transactionId: null }, TEST_TITLE);
        return { status: "TEST" as const, nudge: `${TEST_TITLE}\n${TEST_BODY}`, nudgeTitle: TEST_TITLE, nudgeBody: TEST_BODY };
      }
      const result = await ingestCapture(
        userId,
        "text" in body ? { source: "SHORTCUT", forwarded: body } : { source: "SHORTCUT", shortcut: body as ShortcutPayload },
      );
      const n = await captureNudge(userId, result);
      await record({ kind: "text" in body ? "FORWARDED" : "PAYMENT", status: result.status, transactionId: result.mergedIntoId ?? result.transactionId }, n.title);
      return { ...result, nudge: n.nudge, nudgeTitle: n.title, nudgeBody: n.body };
    },
  );

  /*
   * The voice Shortcut: Record Audio (or Dictate Text) → POST here with the Shortcut key → the transcript goes to the
   * agent as a chat message, in a read-only turn (no payment tool: the key's one power stays logging spending), and
   * the answer comes back as `reply` for Speak Text or Show Notification. Every answer the person should hear,
   * failures included, is a 200 with `reply`: a Shortcut shows a response body, not a status code.
   */
  app.post(
    "/capture/voice",
    {
      onRequest: async (req) => {
        shortcutUsers.set(req, await shortcutDevice(req));
      },
      bodyLimit: Math.ceil((MAX_VOICE_BYTES * 4) / 3) + 64 * 1024,
      schema: {
        body: z
          .object({
            /** Base64 audio (Shortcuts: Base64 Encode the recording). */
            audio: z.string().max(Math.ceil((MAX_VOICE_BYTES * 4) / 3) + 8).optional(),
            format: z.enum(VOICE_FORMATS).default("m4a"),
            /** Already transcribed on the iPhone (Dictate Text): no audio model needed. */
            text: z.string().max(2000).optional(),
          })
          .refine((b) => !!b.audio?.trim() || !!b.text?.trim(), { message: "Send audio or text" }),
        response: {
          200: z.object({ ok: z.boolean(), transcript: z.string(), reply: z.string(), conversationId: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const device = shortcutUsers.get(req);
      if (!device) throw new HttpProblem(401, "DEVICE_TOKEN_REQUIRED", "Shortcut device token missing");
      const { userId } = device;
      const fail = (reply: string, transcript = "") => ({ ok: false, transcript, reply, conversationId: null });
      try {
        await assertAiProcessingAllowed(userId);
      } catch {
        return fail("Kassa needs your OK for AI first: open Kassa, Chat, and accept the AI notice.");
      }
      let transcript = req.body.text?.trim() ?? "";
      if (!transcript) {
        const audio = req.body.audio!.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
        try {
          transcript = await transcribeAudio(audio, req.body.format);
        } catch (e) {
          req.log.warn({ err: e }, "voice transcription failed");
          if (isAiConfigError(e)) return fail("Voice is not set up on this Kassa server (no voice model key).");
          return fail(e instanceof VoiceError && e.status === 400 ? `The voice model could not read this recording (${req.body.format}). Try the AIFF format.` : "Kassa could not hear that. Try again.");
        }
      }
      if (!transcript) return fail("Kassa heard nothing. Try again, a little closer to the microphone.");

      const conversationId = randomUUID();
      await claimConversation(conversationId, userId, "agent", `🎙 ${transcript.slice(0, 56)}`);
      let reply = "";
      try {
        const turn = await startTurn({
          ports: dbPorts(userId, conversationId),
          store: dbTurnStore(conversationId, userId),
          text: transcript,
          mode: await currentAgentMode(),
          readOnly: true,
          // A spoken reply has no cards: any order line would be part of the text.
          cardless: true,
          emit: () => undefined,
        });
        const reader = turn.uiStream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === "text-delta") reply += value.delta;
        }
        await turn.done;
      } catch (e) {
        req.log.error({ err: e }, "voice turn failed");
        return { ok: false, transcript, reply: "Kassa could not answer just now. Try again.", conversationId };
      }
      return { ok: true, transcript, reply: reply.trim() || "Done.", conversationId };
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
