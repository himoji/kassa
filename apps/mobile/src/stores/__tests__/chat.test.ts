import { beforeEach, describe, expect, it } from "@jest/globals";

import { storage } from "@/lib/storage";

import { CHAT_STORE_KEY, useChatStore } from "../chat";

describe("chat store", () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });

  it("persists only the conversation ids", async () => {
    useChatStore.getState().setConversationId("c1");
    useChatStore.getState().setOnboardingConversationId("o1");
    const raw = await storage.getItem(CHAT_STORE_KEY);
    expect(JSON.parse(raw!).state).toEqual({
      conversationId: "c1",
      onboardingConversationId: "o1",
    });
  });

  it("newConversation mints a fresh id and persists it", async () => {
    useChatStore.getState().setConversationId("c1");
    useChatStore.getState().newConversation();
    const id = useChatStore.getState().conversationId;
    expect(id).not.toBe("c1");
    expect(JSON.parse((await storage.getItem(CHAT_STORE_KEY))!).state.conversationId).toBe(id);
  });

  it("rehydrates the ids from storage", async () => {
    await storage.setItem(
      CHAT_STORE_KEY,
      JSON.stringify({ state: { conversationId: "x", onboardingConversationId: "y" }, version: 0 })
    );
    await useChatStore.persist.rehydrate();
    expect(useChatStore.getState().conversationId).toBe("x");
    expect(useChatStore.getState().onboardingConversationId).toBe("y");
  });

  it("reset forgets the persisted ids", async () => {
    useChatStore.getState().setConversationId("c1");
    useChatStore.getState().reset();
    expect(useChatStore.getState().conversationId).not.toBe("c1");
    await expect(storage.getItem(CHAT_STORE_KEY)).resolves.toBeNull();
  });
});
