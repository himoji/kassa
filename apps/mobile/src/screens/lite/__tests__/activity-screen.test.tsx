import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { RecentCapturesResponse } from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";
import { dataModeStore, setDataMode } from "@/lite/data-mode";
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
    {
      id: "00000000-0000-4000-8000-000000000003",
      source: "shortcut",
      merchant: "SQ *BB 0412",
      amountMinor: 210000,
      currency: "HUF",
      homeAmountMinor: null,
      category: "eating_out",
      occurredAt: "2026-10-27T07:00:00.000Z",
      createdAt: "2026-10-27T07:00:05.000Z",
      place: { name: "Blue Bottle Coffee", kind: "café", where: "Váci utca 10, Budapest" },
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
    // The likely place replaces the statement text; where it happened joins the caption.
    expect(screen.getByText("Blue Bottle Coffee")).toBeTruthy();
    expect(screen.queryByText("SQ *BB 0412")).toBeNull();
    expect(screen.getByText(/.* · Eating out · Váci utca 10, Budapest/)).toBeTruthy();
    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith(DATA));
  });

  it("real mode (default) hides simulated and demo-seed purchases, and does not notify them", async () => {
    dataModeStore.reset();
    const sim = {
      ...DATA,
      captures: [
        ...DATA.captures,
        {
          ...DATA.captures[0]!,
          id: "00000000-0000-4000-8000-000000000004",
          source: "NOTIF_SIM",
          merchant: "Simulated Shop",
        },
        {
          ...DATA.captures[0]!,
          id: "00000000-0000-4000-8000-000000000005",
          merchant: "Seeded Market",
          createdAt: DATA.captures[0]!.occurredAt,
        },
      ],
    };
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(sim), { headers: { "content-type": "application/json" } })
      );
    const view = () => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <ThemeProvider>
          <ActivityScreen />
        </ThemeProvider>
      </QueryClientProvider>
    );
    await render(view());
    expect(await screen.findByText("Newest Cafe")).toBeTruthy();
    expect(screen.queryByText("Simulated Shop")).toBeNull();
    expect(screen.queryByText("Seeded Market")).toBeNull();
    expect(screen.getByText(/2 simulated purchases hidden/)).toBeTruthy();
    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith(DATA));

    setDataMode("simulated");
    expect(await screen.findByText("Simulated Shop")).toBeTruthy();
    expect(screen.getByText("Seeded Market")).toBeTruthy();
    expect(screen.queryByTestId("simulated-hidden")).toBeNull();
    dataModeStore.reset();
  });

  it("sorts by occurredAt, newest first", () => {
    expect(sortCaptures(DATA.captures).map((c) => c.merchant)).toEqual([
      "Newest Cafe",
      "Older Bakery",
      "SQ *BB 0412",
    ]);
  });
});
