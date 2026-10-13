/**
 * Chat UI state: the agent conversation id and the onboarding conversation id (spec §8
 * `conversationId`, RFC 9562 UUID v4), persisted through the app KV store so a reload resumes the
 * same server-side conversation. Ids only - message content never lives here (the server keeps
 * history; native keeps an encrypted offline copy in `@/lib/chat-cache`).
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { uuidv4 } from "@/lib/uuid";

import { zustandStorage } from "./zustand-storage";

export const CHAT_STORE_KEY = "kassa:chat-ids";

interface ChatState {
  conversationId: string;
  onboardingConversationId: string;
  newConversation(): void;
  setConversationId(id: string): void;
  setOnboardingConversationId(id: string): void;
  /** Sign-out / account erase: forget both ids (fresh ones are minted) and the persisted copy. */
  reset(): void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversationId: uuidv4(),
      onboardingConversationId: uuidv4(),
      newConversation: () => set({ conversationId: uuidv4() }),
      setConversationId: (conversationId) => set({ conversationId }),
      setOnboardingConversationId: (onboardingConversationId) => set({ onboardingConversationId }),
      reset: () => {
        set({ conversationId: uuidv4(), onboardingConversationId: uuidv4() });
        void useChatStore.persist.clearStorage();
      },
    }),
    {
      name: CHAT_STORE_KEY,
      storage: createJSONStorage(() => zustandStorage),
      partialize: (s) => ({
        conversationId: s.conversationId,
        onboardingConversationId: s.onboardingConversationId,
      }),
    }
  )
);

/** True once the persisted ids are loaded (immediate on native, one async read on web). */
export function useChatHydrated(): boolean {
  return useSyncExternalStore(
    (cb) => useChatStore.persist.onFinishHydration(cb),
    () => useChatStore.persist.hasHydrated(),
    () => false
  );
}
