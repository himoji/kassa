import {
  ConversationMessagesResponse,
  ConversationsResponse,
  OnboardingConversationResponse,
  RenameConversationRequest,
  type StoredUIMessage,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { removeCachedMessages } from "@/lib/chat-cache";
import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { KassaApiError } from "../errors";
import { keys } from "../keys";

/** GET /agent/conversations: the caller's chats with the agent, most recently active first. */
export function useConversations() {
  return useQuery({
    queryKey: keys.conversations,
    queryFn: ({ signal }) =>
      api.request("/agent/conversations", { schema: ConversationsResponse, signal }),
    enabled: useSessionStore((s) => s.status) === "authenticated",
    staleTime: 15_000,
  });
}

/** PATCH /agent/conversations/:id: a new title for a chat. */
export function useRenameConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.request(`/agent/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: RenameConversationRequest.parse({ title }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.conversations }),
  });
}

/** DELETE /agent/conversations/:id: the chat and everything stored for it, and its offline copy here. */
export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.request(`/agent/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      await removeCachedMessages(id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.conversations }),
  });
}

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
