import type { ModelMessage } from "ai";
import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { agentDocuments } from "../../db/schema.intel.ts";
import type { ReaderResult } from "../reader/index.ts";
import { appendHistory, loadHistory, loadPlaceholders, savePlaceholders } from "./history.ts";
import type { TurnStore } from "./loop.ts";

/** DB-backed TurnStore for one conversation. */
export function dbTurnStore(conversationId: string, userId: string, channel: "agent" | "onboarding" = "agent"): TurnStore {
  return {
    history: () => loadHistory(conversationId, userId),
    placeholders: () => loadPlaceholders(conversationId, userId),
    saveMessages: (messages: ModelMessage[]) => appendHistory(conversationId, userId, channel, messages),
    savePlaceholders: (entries) => savePlaceholders(conversationId, userId, entries),
    async readDocs() {
      const rows = await getDb()
        .select({ id: agentDocuments.id, r: agentDocuments.readerResult })
        .from(agentDocuments)
        .where(and(eq(agentDocuments.userId, userId), eq(agentDocuments.conversationId, conversationId), isNotNull(agentDocuments.readerResult)));
      return new Map(rows.map((x) => [x.id, x.r as unknown as ReaderResult]));
    },
  };
}
