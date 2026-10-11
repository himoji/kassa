import type { ModelMessage } from "ai";
import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { agentMessages } from "../../db/schema.intel.ts";
import { placeholderMaps } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import type { PlaceholderEntry, PlaceholderKind } from "./redact.ts";

/*
 * Conversation persistence. Only redacted, model-facing messages are stored (I11). Conversations are
 * owned by one user: a conversationId already used by another user is rejected.
 */

export const MAX_HISTORY_MESSAGES = 40;

export async function conversationOwner(conversationId: string): Promise<string | null> {
  const r = await getDb().select({ userId: agentMessages.userId }).from(agentMessages).where(eq(agentMessages.conversationId, conversationId)).limit(1);
  return r[0]?.userId ?? null;
}

export async function loadHistory(conversationId: string, userId: string): Promise<ModelMessage[]> {
  const rows = await getDb()
    .select({ message: agentMessages.message })
    .from(agentMessages)
    .where(and(eq(agentMessages.conversationId, conversationId), eq(agentMessages.userId, userId)))
    .orderBy(asc(agentMessages.seq));
  const all = rows.map((r) => r.message);
  // Keep the tail, but never start on a tool message (it would orphan its tool call).
  let start = Math.max(0, all.length - MAX_HISTORY_MESSAGES);
  while (start < all.length && all[start]!.role !== "user") start++;
  return all.slice(start);
}

export async function appendHistory(conversationId: string, userId: string, channel: "agent" | "onboarding", messages: ModelMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const db = getDb();
  const max = await db
    .select({ m: sql<number>`coalesce(max(${agentMessages.seq}), -1)` })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId));
  let seq = Number(max[0]?.m ?? -1);
  const now = clock.now();
  await db.insert(agentMessages).values(messages.map((message) => ({ conversationId, userId, channel, seq: ++seq, message, createdAt: now })));
}

export async function loadPlaceholders(conversationId: string): Promise<PlaceholderEntry[]> {
  const rows = await getDb().select().from(placeholderMaps).where(eq(placeholderMaps.conversationId, conversationId));
  return rows.map((r) => ({ placeholder: r.placeholder, kind: r.kind as PlaceholderKind, realRef: r.realRef }));
}

export async function savePlaceholders(conversationId: string, entries: PlaceholderEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await getDb()
    .insert(placeholderMaps)
    .values(entries.map((e) => ({ conversationId, placeholder: e.placeholder, kind: e.kind, realRef: e.realRef })))
    .onConflictDoNothing();
}
