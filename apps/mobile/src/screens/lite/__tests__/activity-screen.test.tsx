import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { RecentCapturesResponse } from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";
import { useSessionStore } from "@/stores/session";
import { ActivityScreen, sortCaptures } from "../activity-screen";

const mockNotify = jest.fn((_: unknown) => Promise.resolve(0));
jest.mock("@/lite/notifier", () => ({ notifyNewCaptures: (r: unknown) => mockNotify(r) }));

const DATA: RecentCapturesResponse = {
  serverTime: "2026-10-27T10:00:00.000Z",
  captures: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      source: "shortcut",
      merchant: "Older Bakery",
      amountMinor: 45000,
      currency: "HUF",
      homeAmountMinor: null,
      category: "Eating out",
      occurredAt: "2026-10-27T08:00:00.000Z",
      createdAt: "2026-10-27T08:00:05.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      source: "shortcut",
      merchant: "Newest Cafe",
      amountMinor: 129000,
      currency: "HUF",
      homeAmountMinor: null,
      category: null,
      occurredAt: "2026-10-27T09:30:00.000Z",
      createdAt: "2026-10-27T09:30:05.000Z",
    },
  ],
  nudges: [
    {
      id: "00000000-0000-4000-8000-0000000000aa",
      title: "Eating out is 80% used",
      body: "Two weeks left in the month.",
      createdAt: "2026-10-27T09:31:00.000Z",
    },
  ],
};

describe("ActivityScreen", () => {
  beforeEach(() => {
    mockNotify.mockClear();
    useSessionStore.getState().setStatus("authenticated");
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(DATA), { headers: { "content-type": "application/json" } })
      );
  });

  it("lists captures newest first with the nudges, and hands the response to the notifier", async () => {
    await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <ThemeProvider>
          <ActivityScreen />
        </ThemeProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText("Newest Cafe")).toBeTruthy();
    expect(screen.getByText("Older Bakery")).toBeTruthy();
    expect(screen.getByText("Eating out is 80% used")).toBeTruthy();
    expect(mockNotify).toHaveBeenCalledWith(DATA);
  });

  it("sorts by occurredAt, newest first", () => {
    expect(sortCaptures(DATA.captures).map((c) => c.merchant)).toEqual([
      "Newest Cafe",
      "Older Bakery",
    ]);
  });
});
