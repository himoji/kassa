/**
 * The proposal card shows the signed funding (which balance pays, at most how much) and the server's sentence of the
 * signed order, so the balance the user reads is the one the order debits; a CONVERT proposal reads as a conversion.
 */
import { describe, expect, it, jest } from "@jest/globals";
import type { ProposalSummary } from "@kassa/shared";
import { act, render, screen } from "@testing-library/react-native";

import { ProposalCard } from "@/components/kassa/proposal-card";
import { ThemeProvider } from "@/components/ui";
import { setLanguage } from "@/lib/i18n";

jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { push: jest.fn() },
}));

const ORDER_LINE =
  "Order to sign: EUR 2,400.00 to Budapest University, funded from your HUF balance: at most HUF 960,000.00 incl. fees (route huf-eur-wise).";

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
  orderFacts: { stance: "TO_SIGN", rail: "BANK_TRANSFER", linkedAccount: false },
};

const wrap = (p: ProposalSummary) => (
  <ThemeProvider>
    <ProposalCard proposal={p} />
  </ThemeProvider>
);

describe("ProposalCard", () => {
  it("shows the order to sign, worded by the app from the structured fields, and the funding balance", async () => {
    await render(wrap(payment));
    expect(screen.getByTestId("proposal-title")).toHaveTextContent("Budapest University");
    expect(screen.getByTestId("proposal-order-stance")).toHaveTextContent("Order to sign");
    expect(screen.getByTestId("proposal-order-line")).toHaveTextContent(
      /^Order to sign.*2,400\.00 to Budapest University, funded from your HUF balance: at most .*960,000\.00 incl\. fees \(route huf-eur-wise\)\.$/
    );
    expect(screen.queryByText(/Signed order|What you sign/)).toBeNull();
    expect(screen.getByTestId("proposal-funding")).toHaveTextContent(
      /^From your HUF balance · at most .*960,000/
    );
    expect(screen.getByText("Review and sign")).toBeTruthy();
  });

  it("an AUTO order paid under a mandate says so; a refused order has no order block", async () => {
    await render(
      wrap({
        ...payment,
        decision: "AUTO",
        status: "EXECUTED",
        orderFacts: { stance: "PAID_MANDATE", rail: "BANK_TRANSFER", linkedAccount: false },
      })
    );
    expect(screen.getByTestId("proposal-order-stance")).toHaveTextContent(
      "Paid under your mandate"
    );
    expect(screen.queryByText("Review and sign")).toBeNull();

    await render(
      wrap({
        ...payment,
        decision: "REFUSE",
        status: "REFUSED",
        reasonCodes: ["INSUFFICIENT_FUNDS"],
      })
    );
    expect(screen.queryByTestId("proposal-order-line")).toBeNull();
  });

  it("in Chinese the order line is Chinese too (a judge read it in English inside a Chinese reply)", async () => {
    try {
      await act(async () => {
        await setLanguage("zh");
      });
      await render(wrap(payment));
      expect(screen.getByTestId("proposal-order-stance")).toHaveTextContent("待签署的付款指令");
      expect(screen.getByTestId("proposal-order-line")).toHaveTextContent(
        /向 Budapest University 支付 .*从您的 HUF 余额扣款/
      );
      expect(screen.queryByText(/funded from/)).toBeNull();
    } finally {
      await act(async () => {
        await setLanguage("en");
      });
    }
  });

  it("a card from before the structured fields shows the server's English line as it came", async () => {
    await render(
      wrap({ ...payment, orderFacts: undefined, orderLine: "Signed order: EUR 2,400.00 to X." })
    );
    expect(screen.getByTestId("proposal-order-line")).toHaveTextContent(
      "Signed order: EUR 2,400.00 to X."
    );
    expect(screen.queryByTestId("proposal-order-stance")).toBeNull();
  });

  it("no funding row when the order is paid from its own currency, no line without one", async () => {
    await render(
      wrap({
        ...payment,
        funding: { currency: "EUR", maxAmountMinor: 241000, routeId: "eur", markupBps: 0 },
        orderLine: undefined,
        orderFacts: undefined,
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
          "Order to sign: convert from your KZT balance into EUR 2,100.50 in your EUR balance.",
        orderFacts: {
          stance: "TO_SIGN",
          rail: "CONVERT",
          linkedAccount: false,
          conversion: {
            fromCurrency: "KZT",
            toCurrency: "EUR",
            amountMinor: 210050,
            maxDebitMinor: 120000000,
            routeId: "kzt-eur",
          },
        },
      })
    );
    expect(screen.getByTestId("proposal-title")).toHaveTextContent("Convert into EUR");
    expect(screen.getByTestId("proposal-order-line")).toHaveTextContent(
      /Convert from your KZT balance into .*2,100\.50 in your EUR balance/
    );
    expect(screen.queryByText("Your Kassa wallet")).toBeNull();
    expect(screen.getByTestId("proposal-funding")).toHaveTextContent(/From your KZT balance/);
  });
});
