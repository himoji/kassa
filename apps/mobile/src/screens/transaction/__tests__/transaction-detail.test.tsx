import { describe, expect, it } from "@jest/globals";
import type { TransactionDetailResponse } from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";

import { purchaseHref, TransactionDetailBody } from "../transaction-detail-screen";

const ID = "00000000-0000-4000-8000-000000000001";
const DETAIL: TransactionDetailResponse = {
  transaction: {
    id: ID,
    source: "SHORTCUT",
    occurredAt: "2026-10-10T08:00:00.000Z",
    merchantRaw: "SQ *BLUE BOTTLE",
    merchantNorm: "blue bottle",
    mcc: null,
    amountMinor: 180_000,
    currency: "HUF",
    cardId: null,
    homeAmountMinor: 180_000,
    rateUsed: null,
    rateDate: null,
    settledAmountMinor: null,
    settledCurrency: null,
    feeHomeMinor: null,
    category: "eating_out",
    mergedIntoId: null,
    status: "PENDING",
  },
  merchant: "Blue Bottle Coffee",
  place: {
    name: "Blue Bottle Coffee",
    kind: "café",
    where: "Váci utca 10, Budapest",
    processor: "Square",
  },
  card: { label: "OTP Visa", last4: "4242" },
  homeCurrency: "HUF",
  category: {
    category: "eating_out",
    spentThisMonthMinor: 750_000,
    countThisMonth: 3,
    typicalMinor: null,
    shareOfMonthPct: 40,
    budget: {
      limitMinor: 2_000_000,
      spentMinor: 750_000,
      remainingMinor: 1_250_000,
      daysLeft: 22,
      pace: "ON_TRACK",
    },
  },
  merchantHistory: {
    visits: 3,
    totalMinor: 500_000,
    averageMinor: 166_667,
    firstAt: "2026-09-14T08:00:00.000Z",
    recent: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-10-03T08:00:00.000Z",
        amountMinor: 170_000,
        currency: "HUF",
      },
    ],
  },
};

describe("TransactionDetailBody", () => {
  it("shows the place, card, statement name, month context and history, and opens the category picker", async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <TransactionDetailBody d={DETAIL} />
        </ThemeProvider>
      </QueryClientProvider>
    );
    expect(screen.getByTestId("purchase-merchant").props.children).toBe("Blue Bottle Coffee");
    expect(screen.getByText("Váci utca 10, Budapest")).toBeTruthy();
    expect(screen.getByText("OTP Visa ·· 4242")).toBeTruthy();
    expect(screen.getByText("SQ *BLUE BOTTLE")).toBeTruthy();
    expect(screen.getByText("Square")).toBeTruthy();
    expect(screen.getByText("Eating out this month")).toBeTruthy();
    expect(screen.getByText(/40% of all your spending/)).toBeTruthy();
    expect(screen.getByText(/3 purchases here/)).toBeTruthy();
    expect(screen.queryByTestId("category-groceries")).toBeNull();
    await fireEvent.press(screen.getByTestId("change-category"));
    expect(screen.getByTestId("category-groceries")).toBeTruthy();
  });

  it("links purchases by id", () => {
    expect(purchaseHref(ID)).toBe(`/purchase/${ID}`);
  });
});
