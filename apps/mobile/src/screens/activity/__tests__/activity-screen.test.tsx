import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { LedgerEntryDto, TransactionDto } from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";

import { router } from "expo-router";

import { ThemeProvider } from "@/components/ui";

import { ActivityScreen, LedgerRow } from "../activity-screen";

const mockCARD = "00000000-0000-4000-8000-0000000000c1";
const mockQ = (data: unknown) => ({
  data,
  isPending: false,
  isLoading: false,
  isError: false,
  isSuccess: true,
  status: "success",
  error: null,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => Promise.resolve(),
  refetch: () => Promise.resolve(),
});
const mockTx = (id: string, merchantRaw: string, cardId: string | null): TransactionDto => ({
  id,
  source: "SHORTCUT",
  occurredAt: "2026-10-27T09:30:00.000Z",
  merchantRaw,
  merchantNorm: merchantRaw.toLowerCase(),
  mcc: null,
  amountMinor: 129000,
  currency: "KZT",
  cardId,
  homeAmountMinor: 129000,
  rateUsed: null,
  rateDate: null,
  settledAmountMinor: null,
  settledCurrency: null,
  feeHomeMinor: null,
  category: null,
  mergedIntoId: null,
  status: "SETTLED",
});
const mockENTRY: LedgerEntryDto = {
  seq: 627,
  ts: "2026-10-27T09:30:00.000Z",
  type: "PROPOSAL_CREATED",
  payload: {
    amountMinor: 500000,
    currency: "KZT",
    decision: "REFUSE",
    reasonCodes: ["PAYEE_COOLING"],
  },
  prevHash: "0".repeat(64),
  hash: "lenOx8wkabcdef",
};
let mockParams: { card?: string } = {};

jest.mock("@/api/hooks/activity", () => ({
  useLedger: () => mockQ({ pages: [{ items: [mockENTRY], nextCursor: null }] }),
  useNotifications: () => mockQ({ notifications: [] }),
  useMarkNotificationRead: () => ({ mutate: jest.fn() }),
}));
jest.mock("@/api/hooks/money", () => ({
  useTransactions: () =>
    mockQ({
      pages: [
        {
          items: [
            mockTx("00000000-0000-4000-8000-000000000001", "On The Card", mockCARD),
            mockTx("00000000-0000-4000-8000-000000000002", "Other Shop", null),
          ],
          nextCursor: null,
        },
      ],
    }),
  useCards: () =>
    mockQ({
      cards: [
        {
          id: mockCARD,
          label: "Kaspi Gold",
          last4: "4242",
          billingCurrency: "KZT",
          kind: "HOME_KZT",
        },
      ],
    }),
}));
jest.mock("@/api/hooks/me", () => ({ useMe: () => mockQ({ homeCurrency: "KZT" }) }));
jest.mock("@/api/hooks/insights", () => ({ useSpendingInsights: () => mockQ(undefined) }));
jest.mock("@/api/hooks/shop", () => ({ useShopOrders: () => mockQ({ shopOrders: [] }) }));
jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  return {
    ...actual,
    router: { push: jest.fn(), navigate: jest.fn(), setParams: jest.fn() },
    useLocalSearchParams: () => mockParams,
  };
});

function wrap(ui: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>{ui}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("ActivityScreen (full app)", () => {
  beforeEach(() => {
    mockParams = {};
  });

  it("opens on Spending: purchases, not the audit log", async () => {
    await wrap(<ActivityScreen />);
    expect(screen.getByText("On The Card")).toBeTruthy();
    expect(screen.getByText("Other Shop")).toBeTruthy();
    expect(screen.queryByTestId("ledger-627")).toBeNull();
    expect(screen.queryByTestId("activity-card-filter")).toBeNull();
  });

  it("?card=<id> narrows Spending to that card under a pill that clears it", async () => {
    mockParams = { card: mockCARD };
    await wrap(<ActivityScreen />);
    expect(screen.getByText("On The Card")).toBeTruthy();
    expect(screen.queryByText("Other Shop")).toBeNull();
    expect(screen.getByText("Kaspi Gold ••4242")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("activity-card-filter"));
    expect(router.setParams).toHaveBeenCalledWith({ card: undefined });
  });
});

describe("LedgerRow", () => {
  it("shows title, amount, time and a refused chip; the explanation and event hash only once tapped", async () => {
    await wrap(<LedgerRow entry={mockENTRY} />);
    expect(screen.getByText("Payment proposed")).toBeTruthy();
    expect(screen.getByTestId("ledger-refused-627")).toBeTruthy();
    expect(screen.queryByText(/event 627/)).toBeNull();
    expect(screen.queryByText(/lenOx8wk/)).toBeNull();
    expect(screen.queryByTestId("ledger-details-627")).toBeNull();

    await fireEvent.press(screen.getByTestId("ledger-627"));
    expect(screen.getByTestId("ledger-details-627")).toBeTruthy();
    expect(screen.getByText(/event 627 · lenOx8wk/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId("ledger-627"));
    expect(screen.queryByTestId("ledger-details-627")).toBeNull();
  });
});
