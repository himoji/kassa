import { describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";

import { ThemeProvider } from "@/components/ui";

/** Renders the lite Home, Settings, Shortcut and Demo screens with realistic data, so a crash fails CI. */

const mockCARD = "00000000-0000-4000-8000-0000000000c1";
const mockQ = (data: unknown) => ({
  data,
  isLoading: false,
  isError: false,
  isSuccess: true,
  status: "success",
  isRefetching: false,
  error: null,
  refetch: () => Promise.resolve(),
});
const mockNow = new Date().toISOString();
const mockToday = mockNow.slice(0, 10);

jest.mock("@/api/hooks/insights", () => ({
  useSpendingInsights: () =>
    mockQ({
      homeCurrency: "KZT",
      month: { start: mockToday, end: mockToday, daysTotal: 31, daysElapsed: 19, daysLeft: 12 },
      totalMinor: 385976,
      count: 2,
      lastMonthToDateMinor: null,
      lastMonthTotalMinor: null,
      typicalMonthMinor: null,
      projectedMinor: 385976,
      monthlyIncomeMinor: null,
      incomeUsedPct: null,
      outsideBudgetsMinor: 0,
      daily: [],
      categories: [],
      topMerchants: [],
    }),
  useTransactionDetail: () => mockQ(undefined),
}));
jest.mock("@/api/hooks/me", () => ({
  useMe: () => mockQ({ id: "u", displayName: "Madiyar", homeCurrency: "KZT", frozenAt: null }),
  useFreeze: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/api/hooks/payees", () => ({ usePayees: () => mockQ({ payees: [] }) }));
jest.mock("@/api/hooks/money", () => ({
  useBalances: () =>
    mockQ({ homeCurrency: "KZT", homeTotalMinor: 0, balances: [], rateDate: null, simulated: true }),
  useBudgets: () =>
    mockQ({
      homeCurrency: "KZT",
      budgets: [
        {
          id: "b1",
          category: "groceries",
          periodStart: mockToday,
          periodEnd: mockToday,
          limitHomeMinor: 20000000,
          spentHomeMinor: 385976,
          remainingHomeMinor: 19614024,
          daysLeft: 12,
          pace: "ON_TRACK",
          projectedRunOutDate: null,
        },
      ],
    }),
  useObligations: () => mockQ({ obligations: [] }),
  useCards: () =>
    mockQ({ cards: [{ id: mockCARD, label: "ACB SALARY NU", last4: "1234", billingCurrency: "KZT", kind: "DEBIT" }] }),
  useCardFees: () =>
    mockQ({ homeCurrency: "KZT", profiles: [], monthlyFeesLostHomeMinor: 0, bestCardByCurrency: [], dccWarnings: [] }),
  usePendingProposals: () => mockQ({ proposals: [] }),
  useAgentActivity: () => mockQ({ since: mockNow, counts: { PAID_AUTO: 1, WAITING: 0, HELD: 2 }, items: [] }),
  useTransactions: () => mockQ({ pages: [{ items: [], nextCursor: null }] }),
  useCreateCard: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lite/use-recent-captures", () => ({
  useRecentCaptures: () =>
    mockQ({
      serverTime: mockNow,
      nudges: [],
      captures: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          source: "SHORTCUT",
          merchant: "Spar",
          amountMinor: 61500,
          currency: "HUF",
          homeAmountMinor: 86162,
          category: "groceries",
          occurredAt: mockNow,
          createdAt: mockNow,
          cardId: mockCARD,
        },
      ],
    }),
}));
jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  const Stack = Object.assign(() => null, { Screen: () => null });
  return { ...actual, Stack, router: { push: jest.fn(), navigate: jest.fn(), setParams: jest.fn() }, useLocalSearchParams: () => ({}) };
});
jest.mock("@/lite/notifier", () => ({ notifyNewCaptures: () => Promise.resolve(0) }));

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>{ui}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("lite screens render", () => {
  it("Home renders the deck and switches pages from the chips", async () => {
    const { LiteHomeScreen } = require("../home-screen");
    const r = await wrap(<LiteHomeScreen />);
    expect(r.getAllByText(/Spent in/).length).toBeGreaterThan(0);
    for (const label of [/ACB SALARY/, /Kassa/]) {
      const chip = r.getAllByText(label)[0]!;
      await fireEvent.press(chip);
    }
  });

  it("Settings renders", async () => {
    const { LiteSettingsScreen } = require("../settings-screen");
    await wrap(<LiteSettingsScreen />);
  });

  it("Shortcut and Demo screens render", async () => {
    const { LiteShortcutScreen } = require("../shortcut-screen-lite");
    const { LiteDemoScreen } = require("../demo-screen");
    await wrap(<LiteShortcutScreen />);
    await wrap(<LiteDemoScreen />);
  });
});
