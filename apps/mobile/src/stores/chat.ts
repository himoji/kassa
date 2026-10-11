/**
 * Chat UI state: one agent conversation id per app session (spec §8 `conversationId`, RFC 9562
 * UUID v4), reset on demand. Messages themselves are held by `useChat`.
 */
import { create } from "zustand";

import { uuidv4 } from "@/lib/uuid";

interface ChatState {
  conversationId: string;
  onboardingConversationId: string;
  newConversation(): void;
}

export const useChatStore = create<ChatState>((set) => ({
  conversationId: uuidv4(),
  onboardingConversationId: uuidv4(),
  newConversation: () => set({ conversationId: uuidv4() }),
}));
