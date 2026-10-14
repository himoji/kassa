import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ConversationSummary } from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";

import { bucketOf, ChatHistoryScreen, sectionChats } from "../history-screen";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { back: () => mockBack(), canGoBack: () => true, push: jest.fn() },
  Stack: { Screen: () => null, Toolbar: Object.assign(() => null, { Button: () => null }) },
}));

const NOW = new Date(2026, 9, 14, 15, 0);
const at = (daysAgo: number, hour = 10) => new Date(2026, 9, 14 - daysAgo, hour, 0).toISOString();
const chat = (id: string, title: string | null, daysAgo: number): ConversationSummary => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  title,
  createdAt: at(daysAgo + 1),
  lastMessageAt: at(daysAgo),
  messageCount: 4,
});
const CHATS = [
  chat("1", "Tuition plan", 40),
  chat("2", "Budget for food", 0),
  chat("3", null, 1),
  chat("4", "Rent", 5),
];

describe("sectionChats", () => {
  it("groups by last activity, newest first", () => {
    expect(bucketOf(at(0), NOW)).toBe("today");
    expect(bucketOf(at(1), NOW)).toBe("yesterday");
    expect(bucketOf(at(5), NOW)).toBe("week");
    expect(bucketOf(at(20), NOW)).toBe("month");
    expect(bucketOf(at(40), NOW)).toBe("older");
    expect(
      sectionChats(CHATS, "", "Untitled", NOW).map((s) => [s.bucket, s.chats.map((c) => c.title)])
    ).toEqual([
      ["today", ["Budget for food"]],
      ["yesterday", [null]],
      ["week", ["Rent"]],
      ["older", ["Tuition plan"]],
    ]);
  });

  it("searches titles, case-insensitively, untitled ones by the placeholder", () => {
    expect(
      sectionChats(CHATS, "  FOOD ", "Untitled", NOW).flatMap((s) => s.chats.map((c) => c.title))
    ).toEqual(["Budget for food"]);
    expect(
      sectionChats(CHATS, "untit", "Untitled", NOW).flatMap((s) => s.chats.map((c) => c.title))
    ).toEqual([null]);
  });
});

describe("ChatHistoryScreen", () => {
  beforeEach(() => {
    mockBack.mockClear();
    useSessionStore.getState().setStatus("authenticated");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ conversations: CHATS }), {
        headers: { "content-type": "application/json" },
      })
    );
  });

  it("lists the chats and opens one", async () => {
    await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <ThemeProvider>
          <ChatHistoryScreen />
        </ThemeProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText("Budget for food")).toBeTruthy();
    expect(screen.getByText("Untitled chat")).toBeTruthy();
    expect(screen.getByText("4 chats")).toBeTruthy();
    await fireEvent.press(screen.getByText("Rent"));
    expect(useChatStore.getState().conversationId).toBe(CHATS[3]!.id);
    expect(mockBack).toHaveBeenCalled();
  });
});
