import {
  ConversationMessagesResponse,
  OnboardingConversationResponse,
  type StoredUIMessage,
} from "@kassa/shared";

import { api } from "../client";
import { KassaApiError } from "../errors";

/**
 * GET /agent/conversations/:id/messages: the stored history, or `null` when the server does not
 * know the conversation for this caller (404: the id is a fresh one, nothing to restore).
 */
export async function fetchConversationMessages(
  conversationId: string,
  signal?: AbortSignal
): Promise<StoredUIMessage[] | null> {
  try {
    const res = await api.request(`/agent/conversations/${conversationId}/messages`, {
      schema: ConversationMessagesResponse,
      signal,
    });
    return res.messages;
  } catch (err) {
    if (err instanceof KassaApiError && err.status === 404) return null;
    throw err;
  }
}

/** GET /onboarding/conversation: the caller's latest onboarding conversation, its turns and draft. */
export function fetchOnboardingConversation(signal?: AbortSignal) {
  return api.request("/onboarding/conversation", {
    schema: OnboardingConversationResponse,
    signal,
  });
}
