import type { ModelMessage } from "ai";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { agentMessages, conversations, onboardingDrafts } from "../../db/schema.intel.ts";
import { placeholderMaps } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import type { PlaceholderEntry, PlaceholderKind } from "./redact.ts";

/*
 * Conversation persistence. Only redacted, model-facing messages are stored (I11). Conversations are
 * owned by one user and one channel: the `conversations` row is authoritative, and a conversationId already
 * used by another user, or by the same user on the other channel, is rejected.
 */

export const MAX_HISTORY_MESSAGES = 40;

export type Channel = "agent" | "onboarding";
export type ConversationOwner = { userId: string; channel: Channel };

/**
 * Owner of a conversation id across every channel: the conversations table first, then legacy rows
 * (agent_messages, onboarding_drafts) written before it existed. null = unused id.
 */
export async function conversationOwner(conversationId: string): Promise<ConversationOwner | null> {
  const db = getDb();
  if (UUID_RE.test(conversationId)) {
    const c = (await db.select({ userId: conversations.userId, channel: conversations.channel }).from(conversations).where(eq(conversations.id, conversationId)))[0];
    if (c) return c;
  }
  const m = (await db.select({ userId: agentMessages.userId, channel: agentMessages.channel }).from(agentMessages).where(eq(agentMessages.conversationId, conversationId)).limit(1))[0];
  if (m) return { userId: m.userId, channel: m.channel === "onboarding" ? "onboarding" : "agent" };
  const d = (await db.select({ userId: onboardingDrafts.userId }).from(onboardingDrafts).where(eq(onboardingDrafts.conversationId, conversationId)))[0];
  return d ? { userId: d.userId, channel: "onboarding" } : null;
}

export class ConversationForbiddenError extends Error {
  readonly code = "CONVERSATION_FORBIDDEN";
  constructor() {
    super("conversation belongs to another user or channel");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claim (or re-enter) a conversation for this user and channel. The INSERT … ON CONFLICT DO NOTHING is atomic, so
 * when two users race for a new id exactly one row wins and the loser is compared against it. Legacy ids (rows
 * that predate the table) are checked first so a claim can never take over someone else's history.
 * Throws ConversationForbiddenError for another user's id, or the same user's id on the other channel.
 */
export async function claimConversation(conversationId: string, userId: string, channel: Channel, title?: string | null): Promise<void> {
  if (!UUID_RE.test(conversationId)) throw new ConversationForbiddenError();
  const db = getDb();
  const legacy = await conversationOwner(conversationId);
  if (legacy && (legacy.userId !== userId || legacy.channel !== channel)) throw new ConversationForbiddenError();
  await db
    .insert(conversations)
    .values({ id: conversationId, userId, channel, title: title ?? null, createdAt: clock.now() })
    .onConflictDoNothing();
  const row = (await db.select({ userId: conversations.userId, channel: conversations.channel }).from(conversations).where(eq(conversations.id, conversationId)))[0];
  if (!row || row.userId !== userId || row.channel !== channel) throw new ConversationForbiddenError();
}

/** Is this the caller's conversation on this channel? (Read paths: no claim.) */
export async function ownsConversation(conversationId: string, userId: string, channel: Channel): Promise<boolean> {
  const o = await conversationOwner(conversationId);
  return o !== null && o.userId === userId && o.channel === channel;
}

export async function listConversations(userId: string, channel: Channel): Promise<Array<{ id: string; title: string | null; createdAt: Date }>> {
  return getDb()
    .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.channel, channel)))
    .orderBy(desc(conversations.createdAt))
    .limit(100);
}

/** Every stored message of a conversation (not trimmed), oldest first. */
export async function loadAllMessages(conversationId: string, userId: string): Promise<ModelMessage[]> {
  const rows = await getDb()
    .select({ message: agentMessages.message })
    .from(agentMessages)
    .where(and(eq(agentMessages.conversationId, conversationId), eq(agentMessages.userId, userId)))
    .orderBy(asc(agentMessages.seq));
  return rows.map((r) => r.message);
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

/** Placeholder map of a conversation, scoped to its owner: another user's entries are never returned. */
export async function loadPlaceholders(conversationId: string, userId: string): Promise<PlaceholderEntry[]> {
  const rows = await getDb()
    .select()
    .from(placeholderMaps)
    .where(and(eq(placeholderMaps.conversationId, conversationId), eq(placeholderMaps.userId, userId)));
  return rows.map((r) => ({ placeholder: r.placeholder, kind: r.kind as PlaceholderKind, realRef: r.realRef }));
}

export async function savePlaceholders(conversationId: string, userId: string, entries: PlaceholderEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await getDb()
    .insert(placeholderMaps)
    .values(entries.map((e) => ({ conversationId, userId, placeholder: e.placeholder, kind: e.kind, realRef: e.realRef })))
    .onConflictDoNothing();
}
