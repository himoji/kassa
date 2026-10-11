/*
 * In-app notification feed (spec §13 "Delivery: in-app feed always"). `kind` + `data` carry the
 * machine meaning (the app translates); title/body are English fallbacks for push/toasts.
 */
import type { DbOrTx } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { notifications } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";

export async function notify(
  userId: string,
  n: { kind: string; title: string; body: string; data?: Record<string, unknown> },
  db: DbOrTx = getDb(),
): Promise<string> {
  const rows = await db
    .insert(notifications)
    .values({ userId, kind: n.kind, title: n.title, body: n.body, data: n.data ?? null, createdAt: clock.now() })
    .returning({ id: notifications.id });
  return rows[0]!.id;
}
