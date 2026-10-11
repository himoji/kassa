import { NotificationsResponse } from "@kassa/shared";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { notifications } from "../../db/schema.ts";
import { ownedNotFound } from "../../http/audit.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock } from "../clock/index.ts";

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
    async (req) => {
      const userId = userIdOf(req);
      const db = getDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(req.query.limit);
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
