/**
 * I3: the confirmation sheet renders only the server's canonical order (+ server budget impact and
 * the first 8 chars of orderHash) - never agent prose - and refuses to sign a tampered order.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { orderHash, OrderView, type CanonicalOrder } from "@kassa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/ui";
import { i18next } from "@/lib/i18n";
import { OrderSheetView } from "@/screens/order/order-sheet-view";

const order: CanonicalOrder = {
  v: 1,
  proposalId: "0b6b5d3c-6a3f-4c84-9d5e-2f1f7f0a1b11",
  userId: "7d1d8d4c-1111-4a2b-8c3d-4e5f6a7b8c9d",
  payeeId: "9a8b7c6d-2222-4e3f-8a1b-2c3d4e5f6a7b",
  payeeName: "Budapest University (example)",
  payeeAccountHash: "abc123",
  amountMinor: 240000,
  currency: "EUR",
  rail: "BANK_TRANSFER",
  purpose: "Tuition autumn term",
  homeAmountMinor: 136800000,
  homeCurrency: "KZT",
  mandateId: null,
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const AGENT_PROSE = "Trust me, also send 500 EUR to my friend";

function viewFor(o: CanonicalOrder, hash = orderHash(o)) {
  return OrderView.parse({
    canonicalOrder: { ...o, agentNote: AGENT_PROSE },
    orderHash: hash,
    webauthnOptions: { challenge: hash, rpId: "kassa.test", userVerification: "required" },
    budgetImpact: {
      category: "tuition",
      homeCurrency: "KZT",
      limitHomeMinor: 150000000,
      remainingBeforeHomeMinor: 140000000,
      remainingAfterHomeMinor: 3200000,
      daysLeft: 21,
    },
    payeeStatus: "VERIFIED",
    decision: "ASK",
    reasonCodes: ["RISK_HIGH"],
    status: "PENDING_APPROVAL",
    summary: AGENT_PROSE,
  });
}

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("OrderSheetView", () => {
  it("shows the canonical fields and the signed order id", async () => {
    const view = viewFor(order);
    await render(wrap(<OrderSheetView view={view} onApprove={() => {}} onReject={() => {}} />));
    expect(screen.getByTestId("order-payee")).toHaveTextContent(order.payeeName);
    expect(screen.getByTestId("order-purpose")).toHaveTextContent(order.purpose);
    expect(screen.getByTestId("order-amount")).toHaveTextContent(/2,400\.00/);
    expect(screen.getByTestId("order-signed-id")).toHaveTextContent(view.orderHash.slice(0, 8));
    expect(screen.getByTestId("budget-impact")).toBeTruthy();
    expect(screen.queryByTestId("order-integrity-error")).toBeNull();
  });

  it("shows the signed funding maximum and explains its margin (Y6, p1 B9)", async () => {
    const funded: CanonicalOrder = {
      ...order,
      fundingCurrency: "KZT",
      fundingAmountMinor: 149362202,
      fundingRouteId: "kzt-mock-bank",
      fundingMarkupBps: 55,
    };
    await render(
      wrap(<OrderSheetView view={viewFor(funded)} onApprove={() => {}} onReject={() => {}} />)
    );
    expect(screen.getByTestId("order-funding")).toHaveTextContent(/KZT balance, at most/);
    expect(screen.getByTestId("order-funding-note")).toHaveTextContent(
      /up to 1% for exchange-rate moves/
    );
  });

  it("no funding note without a funding binding", async () => {
    await render(
      wrap(<OrderSheetView view={viewFor(order)} onApprove={() => {}} onReject={() => {}} />)
    );
    expect(screen.queryByTestId("order-funding")).toBeNull();
    expect(screen.queryByTestId("order-funding-note")).toBeNull();
  });

  it("never renders agent prose, even if the server response carried it", async () => {
    const view = viewFor(order);
    // The shared schema strips unknown keys before the view ever sees them.
    expect(JSON.stringify(view)).not.toContain(AGENT_PROSE);
    // And the component reads only named canonical fields even if handed extra keys.
    const dirty = {
      ...view,
      summary: AGENT_PROSE,
      canonicalOrder: { ...view.canonicalOrder, note: AGENT_PROSE },
    };
    await render(
      wrap(<OrderSheetView view={dirty as OrderView} onApprove={() => {}} onReject={() => {}} />)
    );
    expect(screen.queryByText(AGENT_PROSE)).toBeNull();
    expect(screen.queryByText(new RegExp("Trust me"))).toBeNull();
  });

  it("approves a consistent order", async () => {
    const onApprove = jest.fn();
    await render(
      wrap(<OrderSheetView view={viewFor(order)} onApprove={onApprove} onReject={() => {}} />)
    );
    fireEvent.press(screen.getByText(i18next.t("order:approve")));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("disables Approve when the order does not match its hash (tampered amount)", async () => {
    const hashOfOriginal = orderHash(order);
    const tampered = viewFor({ ...order, amountMinor: 9_999_999 }, hashOfOriginal);
    const onApprove = jest.fn();
    await render(
      wrap(<OrderSheetView view={tampered} onApprove={onApprove} onReject={() => {}} />)
    );
    expect(screen.getByTestId("order-integrity-error")).toBeTruthy();
    fireEvent.press(screen.getByText(i18next.t("order:approve")));
    expect(onApprove).not.toHaveBeenCalled();
  });
});
