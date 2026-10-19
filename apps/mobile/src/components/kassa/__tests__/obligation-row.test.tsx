/**
 * A bill no single balance pays but converting does (CONVERTIBLE): its own chip, the plan in words, and a press that
 * opens Convert prefilled with the first step. SHORTFALL still opens Add money.
 */
import { describe, expect, it, jest } from "@jest/globals";
import type { ObligationDto } from "@kassa/shared";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { ObligationRow } from "@/components/kassa/obligation-row";
import { ThemeProvider } from "@/components/ui";

jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { push: jest.fn() },
}));

const bill: ObligationDto = {
  id: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  payeeId: "9a8b7c6d-2222-4e3f-8a1b-2c3d4e5f6a7b",
  payeeName: "Budapest University",
  payeeStatus: "VERIFIED",
  payeeAccountMissing: false,
  amountMinor: 240000,
  currency: "EUR",
  homeAmountMinor: 136800000,
  dueDate: "2026-11-01",
  recurrence: "ONCE",
  reference: null,
  category: "tuition",
  bestRoute: null,
  coverage: "CONVERTIBLE",
  conversions: [
    {
      fromCurrency: "KZT",
      toCurrency: "EUR",
      amountMinor: 210050,
      estimatedDebitMinor: 119000000,
      routeId: "kzt-eur",
    },
  ],
  mandateId: null,
};

const wrap = (o: ObligationDto) => (
  <ThemeProvider>
    <ObligationRow obligation={o} homeCurrency="KZT" />
  </ThemeProvider>
);

describe("ObligationRow", () => {
  it("CONVERTIBLE shows the plan and opens Convert with the first step", async () => {
    await render(wrap(bill));
    expect(screen.getByText("Convert first")).toBeTruthy();
    expect(screen.getByTestId(`obligation-convert-plan-${bill.id}`)).toHaveTextContent(
      /^Convert .*2,100\.50 from KZT first, then pay\.$/
    );
    fireEvent.press(screen.getByTestId(`obligation-convertible-${bill.id}`));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/convert",
      params: { fromCurrency: "KZT", toCurrency: "EUR", amountMinor: "210050" },
    });
  });

  it("SHORTFALL still opens Add money", async () => {
    await render(wrap({ ...bill, coverage: "SHORTFALL", conversions: undefined }));
    expect(screen.queryByTestId(`obligation-convert-plan-${bill.id}`)).toBeNull();
    fireEvent.press(screen.getByTestId(`obligation-shortfall-${bill.id}`));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: "/add-money",
      params: { currency: "EUR" },
    });
  });
});
