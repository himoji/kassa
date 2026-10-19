import { describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";

import { CardsScreen } from "../cards-screen";

const mockCARD = "00000000-0000-4000-8000-0000000000c1";
const mockQ = (data: unknown) => ({
  data,
  isPending: false,
  isLoading: false,
  isError: false,
  isSuccess: true,
  status: "success",
  error: null,
  refetch: () => Promise.resolve(),
});
const mockRemove = jest.fn();

jest.mock("@/api/hooks/money", () => ({
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
  useCardFees: () =>
    mockQ({
      homeCurrency: "KZT",
      profiles: [
        {
          cardId: mockCARD,
          fromCurrency: "EUR",
          toCurrency: "KZT",
          medianMarkupBps: 150,
          fixedFeeMinor: 0,
          samples: 7,
        },
      ],
      monthlyFeesLostHomeMinor: 120000,
      bestCardByCurrency: [{ currency: "KZT", cardId: mockCARD }],
      dccWarnings: [],
      exampleValues: false,
    }),
  useCreateCard: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: mockRemove, isPending: false }),
}));
jest.mock("@/api/hooks/me", () => ({
  useMe: () => mockQ({ homeCurrency: "KZT", settings: { homeCurrency: "KZT" } }),
}));
jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  return { ...actual, useLocalSearchParams: () => ({}) };
});

describe("CardsScreen", () => {
  it("shows each card as a compact row; markups and Remove (with its confirm) only after a tap", async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <CardsScreen />
        </ThemeProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText("Kaspi Gold")).toBeTruthy();
    expect(screen.getByText("•• 4242 · KZT")).toBeTruthy();
    expect(screen.getByText("Use for KZT")).toBeTruthy();
    expect(screen.getByText("Fees lost this month")).toBeTruthy();
    expect(screen.queryByText("EUR to KZT")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();

    await fireEvent.press(screen.getByTestId(`card-${mockCARD}`));
    expect(screen.getByText("EUR to KZT")).toBeTruthy();
    await fireEvent.press(screen.getByText("Remove"));
    expect(screen.getByText(/Remove the card ending 4242/)).toBeTruthy();
    expect(mockRemove).not.toHaveBeenCalled();
    await fireEvent.press(screen.getAllByText("Remove").at(-1)!);
    expect(mockRemove).toHaveBeenCalledWith(mockCARD, expect.anything());
  });
});
