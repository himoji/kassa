/*
 * Tables that spec §6 does not list. Same conventions as schema.ts. Logged in docs/architecture/decisions.md.
 *
 * - agent_messages: planner conversation history (spec §9 multi-turn chat). Stores ONLY the redacted
 *   model-facing messages (I11): what the planner saw, never raw personal data.
 * - agent_documents: uploads from POST /agent/documents (spec §8) → `docId`, plus the cached Reader result.
 * - merchant_category_memory: "a user correction is remembered per merchantNorm" (spec §13).
 * - onboarding_drafts: the structured profile draft the onboarding chat builds (spec §8).
 * - conversations: the authoritative owner + channel of every conversation id (agent chat and onboarding). The first
 *   message claims the id (INSERT … ON CONFLICT DO NOTHING); every later request compares user_id and channel.
 */
import type { ModelMessage } from "ai";

import type { OnboardingProfileDraft, ReaderDocType } from "@kassa/shared";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./schema.ts";

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: text("conversation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "agent" | "onboarding" */
    channel: text("channel").notNull(),
    seq: integer("seq").notNull(),
    /** AI SDK ModelMessage, redacted. */
    message: jsonb("message").$type<ModelMessage>().notNull(),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [index("agent_messages_conv_idx").on(t.conversationId, t.seq)],
);

export const agentDocuments = pgTable(
  "agent_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
    filename: text("filename"),
    mediaType: text("media_type").notNull(),
    /** Raw bytes, base64 (RFC 4648 §4). Uploads are capped at 10 MB. */
    dataB64: text("data_b64").notNull(),
    kind: text("kind").$type<ReaderDocType>(),
    /** Cached ReaderResult (reader/schemas.ts) once read. */
    readerResult: jsonb("reader_result").$type<Record<string, unknown>>(),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [index("agent_documents_user_idx").on(t.userId)],
);

export const merchantCategoryMemory = pgTable(
  "merchant_category_memory",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantNorm: text("merchant_norm").notNull(),
    category: text("category").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.merchantNorm] })],
);

export const onboardingDrafts = pgTable("onboarding_drafts", {
  conversationId: text("conversation_id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  draft: jsonb("draft").$type<OnboardingProfileDraft>().notNull(),
  complete: boolean("complete").notNull().default(false),
  updatedAt: tstz("updated_at").notNull(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "agent" | "onboarding" */
    channel: text("channel").$type<"agent" | "onboarding">().notNull(),
    title: text("title"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.createdAt)],
);
