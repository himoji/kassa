import { NotificationsResponse, NotificationsWaitResponse } from "@kassa/shared";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { notifications } from "../../db/schema.ts";
import { ownedNotFound } from "../../http/audit.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock } from "../clock/index.ts";

/** Long poll: the longest a /notifications/wait call holds, and how often it looks at the feed meanwhile. */
const WAIT_MAX_MS = 25_000;
const WAIT_STEP_MS = 1_000;

async function feed(userId: string, limit: number): Promise<NotificationsResponse> {
  const db = getDb();
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  const unread = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return {
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      data: r.data,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    unread: unread[0]?.n ?? 0,
  };
}

/**
 * What a long poll compares: how many notifications the user has and the newest one's id. A count alone misses an
 * add that a retention delete cancels out; the newest id alone misses a row stamped earlier by a moved demo clock.
 */
async function feedCursor(userId: string): Promise<string> {
  const db = getDb();
  const [total] = await db.select({ n: count() }).from(notifications).where(eq(notifications.userId, userId));
  const [newest] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return `${total?.n ?? 0}:${newest?.id ?? ""}`;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get(
    "/notifications",
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: NotificationsResponse },
      },
    },
    async (req) => feed(userIdOf(req), req.query.limit),
  );

  /**
   * Real-time feed for the app (money from another Kassa wallet, payment outcomes): a long poll rather than a
   * WebSocket, because the API also runs as a Vercel Function, which cannot hold a socket open.
   */
  app.get(
    "/notifications/wait",
    {
      schema: {
        querystring: z.object({
          cursor: z.string().max(100).optional(),
          waitMs: z.coerce.number().int().min(0).max(WAIT_MAX_MS).default(WAIT_MAX_MS),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: NotificationsWaitResponse },
      },
    },
    async (req) => {
      const userId = userIdOf(req);
      const { cursor: known, waitMs, limit } = req.query;
      let closed = false;
      req.raw.once("close", () => {
        closed = true;
      });
      const deadline = Date.now() + waitMs;
      let cursor = await feedCursor(userId);
      while (known !== undefined && cursor === known && !closed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_STEP_MS, Math.max(0, deadline - Date.now()))));
        if (closed) break;
        cursor = await feedCursor(userId);
      }
      return { ...(await feed(userId, limit)), cursor, changed: cursor !== known };
    },
  );

  app.post(
    "/notifications/:id/read",
    { schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const userId = userIdOf(req);
      const rows = await getDb()
        .update(notifications)
        .set({ readAt: clock.now() })
        .where(and(eq(notifications.id, req.params.id), eq(notifications.userId, userId)))
        .returning({ id: notifications.id });
      if (rows.length === 0) {
        throw await ownedNotFound(userId, "notification", req.params.id, async () => (await getDb().select({ id: notifications.id }).from(notifications).where(eq(notifications.id, req.params.id))).length > 0);
      }
      return { ok: true };
    },
  );
};

export default routes;
