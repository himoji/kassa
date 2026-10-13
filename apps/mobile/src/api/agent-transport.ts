/**
 * Agent chat transport (spec §8 POST /agent/message, §9 streaming). The server answers with an
 * AI SDK UI message stream; on native the global fetch is expo/fetch, which streams bodies.
 * The request body is the spec's `{ conversationId, text }` (+ optional `choice`) - the server keeps the history.
 */
import {
  AgentDataParts,
  AgentMessageMetadata,
  type AgentDataPartTypes,
  type ChoiceAnswer,
} from "@kassa/shared";
import { DefaultChatTransport, type UIMessage } from "ai";

import { api } from "./client";

export type KassaUIMessage = UIMessage<AgentMessageMetadata, AgentDataPartTypes>;

/** The text of the newest user message: what the spec's `text` field carries. */
export function lastUserText(messages: readonly KassaUIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    return m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

export function createAgentTransport(conversationId: string) {
  return new DefaultChatTransport<KassaUIMessage>({
    api: api.url("/agent/message"),
    credentials: api.kind === "web" ? "include" : undefined,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      api.authorizedFetch(String(input), init)) as typeof globalThis.fetch,
    // `body` carries the per-request extras of `sendMessage(msg, { body: { choice } })`: a tapped
    // ChoiceCard answer the server validates against the stored picker.
    prepareSendMessagesRequest: ({ messages, body }) => {
      const choice = body?.choice as ChoiceAnswer | undefined;
      return {
        body: { conversationId, text: lastUserText(messages), ...(choice ? { choice } : {}) },
      };
    },
  });
}

/** Runtime validation of data parts and metadata: cards only render contract-shaped objects. */
export const agentChatSchemas = {
  dataPartSchemas: AgentDataParts,
  messageMetadataSchema: AgentMessageMetadata,
};
