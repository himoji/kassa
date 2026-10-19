/**
 * The proposal card shows the signed funding (which balance pays, at most how much) and the server's sentence of the
 * signed order, so the balance the user reads is the one the order debits; a CONVERT proposal reads as a conversion.
 */
import { describe, expect, it, jest } from "@jest/globals";
import type { ProposalSummary } from "@kassa/shared";
import { render, screen } from "@testing-library/react-native";

import { ProposalCard } from "@/components/kassa/proposal-card";
import { ThemeProvider } from "@/components/ui";

jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { push: jest.fn() },
}));

const ORDER_LINE =
  "Signed order: EUR 2,400.00 to Budapest University, funded from your HUF balance: at most HUF 960,000.00 incl. fees (route huf-eur-wise).";

const payment: ProposalSummary = {
  proposalId: "0b6b5d3c-6a3f-4c84-9d5e-2f1f7f0a1b11",
  createdBy: "AGENT",
  decision: "ASK",
  reasonCodes: ["RISK_HIGH"],
  riskScore: 0.2,
  status: "PENDING_APPROVAL",
  payeeName: "Budapest University",
  amountMinor: 240000,
  currency: "EUR",
  homeAmountMinor: 136800000,
  homeCurrency: "KZT",
  createdAt: "2026-10-18T10:00:00.000Z",
  kind: "PAYMENT",
  funding: { currency: "HUF", maxAmountMinor: 96000000, routeId: "huf-eur-wise", markupBps: 40 },
  orderLine: ORDER_LINE,
};

const wrap = (p: ProposalSummary) => (
  <ThemeProvider>
    <ProposalCard proposal={p} />
  </ThemeProvider>
);

describe("ProposalCard", () => {
  it("shows the signed order line and the funding balance with its maximum", async () => {
    await render(wrap(payment));
    expect(screen.getByTestId("proposal-title")).toHaveTextContent("Budapest University");
    expect(screen.getByTestId("proposal-order-line")).toHaveTextContent(
      `What you sign${ORDER_LINE}`
    );
    expect(screen.getByTestId("proposal-funding")).toHaveTextContent(
      /^From your HUF balance · at most .*960,000/
    );
    expect(screen.getByText("Review and sign")).toBeTruthy();
  });

  it("no funding row when the order is paid from its own currency, no line without one", async () => {
    await render(
      wrap({
        ...payment,
        funding: { currency: "EUR", maxAmountMinor: 241000, routeId: "eur", markupBps: 0 },
        orderLine: undefined,
      })
    );
    expect(screen.queryByTestId("proposal-funding")).toBeNull();
    expect(screen.queryByTestId("proposal-order-line")).toBeNull();
  });

  it("a CONVERT proposal shows the conversion title instead of a payee", async () => {
    await render(
      wrap({
        ...payment,
        kind: "CONVERT",
        payeeName: "Your Kassa wallet",
        amountMinor: 210050,
        funding: { currency: "KZT", maxAmountMinor: 120000000, routeId: "kzt-eur", markupBps: 50 },
        orderLine:
          "Signed order: convert from your KZT balance into EUR 2,100.50 in your EUR balance.",
      })
    );
    expect(screen.getByTestId("proposal-title")).toHaveTextContent("Convert into EUR");
    expect(screen.queryByText("Your Kassa wallet")).toBeNull();
    expect(screen.getByTestId("proposal-funding")).toHaveTextContent(/From your KZT balance/);
  });
});
