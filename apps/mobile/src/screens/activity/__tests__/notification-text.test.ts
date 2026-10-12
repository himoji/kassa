import { describe, expect, it } from "@jest/globals";

import { i18next } from "@/lib/i18n";

import { notificationReasonCodes, notificationText } from "../notification-text";

const t = (key: string, vars?: Record<string, string | number>) => i18next.t(key, vars);
const money = (a: number, c: string) => `${c} ${(a / 100).toFixed(2)}`;

describe("notificationText", () => {
  it("renders payment.sent from {key, params} with the home amount", () => {
    const r = notificationText(
      {
        title: "x",
        body: "y",
        data: {
          key: "payment.sent",
          params: {
            payee: "University in Budapest",
            amount: { amountMinor: 240000, currency: "EUR" },
            home: { amountMinor: 146976000, currency: "KZT" },
            rail: "BANK_TRANSFER",
            mandate: null,
            reasonCodes: [],
          },
        },
      },
      t,
      money
    );
    expect(r.title).toBe("Payment sent to University in Budapest");
    expect(r.body).toContain("EUR 2400.00 (about KZT 1469760.00) to University in Budapest");
  });

  it("renders budget.each with the home equivalent", () => {
    const r = notificationText(
      {
        title: "x",
        body: "y",
        data: {
          key: "budget.each",
          params: {
            amount: { amountMinor: 3250, currency: "CNY" },
            home: { amountMinor: 239795, currency: "KZT" },
            merchant: "Convenience Store (sample)",
            category: "groceries",
            usedPct: 85,
            leftPct: 15,
            days: 5,
          },
        },
      },
      t,
      money
    );
    expect(r.body).toBe(
      "CNY 32.50 (about KZT 2397.95) at Convenience Store (sample). Groceries: 85% used, 15% left for 5 days."
    );
  });

  it("renders supplier / purchase-order notifications", () => {
    const n = (key: string, params: Record<string, unknown>) =>
      notificationText({ title: "x", body: "y", data: { key, params } }, t, money);
    expect(
      n("business.poDrafted", {
        supplier: "Fresh Farm",
        total: { amountMinor: 1250000, currency: "HUF" },
      }).body
    ).toContain("Fresh Farm (HUF 12500.00)");
    expect(n("business.poDelivered", { supplier: "Fresh Farm" }).title).toBe("Delivery received");
    expect(
      n("business.invoiceRefused", { supplier: "D", reason: "INVOICE_ACCOUNT_MISMATCH" }).title
    ).toBe("Invoice with different bank details");
    expect(n("business.invoiceRefused", { supplier: "D", reason: "INVOICE_ABOVE_PO" }).title).toBe(
      "Invoice above your purchase order"
    );
    expect(n("business.invoiceRefused", { supplier: "D", reason: "WHAT" }).title).toBe("x");
  });

  it("renders shop order status updates", () => {
    const n = (params: Record<string, unknown>) =>
      notificationText(
        { title: "x", body: "y", data: { key: "shop.orderStatus", params } },
        t,
        money
      );
    expect(n({ merchant: "Pizza", status: "COOKING", channel: "DELIVERY" }).title).toBe(
      "Pizza: Being prepared"
    );
    expect(n({ merchant: "Bud", status: "PAID", channel: "TILL" }).body).toContain("counter till");
    expect(
      n({ merchant: "Pizza", status: "DECLINED", reasonCode: "CARD_DECLINED" }).body
    ).toContain("CARD_DECLINED");
    expect(n({ merchant: "Pizza", status: "NOPE" }).title).toBe("x");
  });

  it("falls back to the stored English text for unknown or malformed data", () => {
    expect(notificationText({ title: "T", body: "B", data: null }, t, money)).toEqual({
      title: "T",
      body: "B",
    });
    expect(
      notificationText(
        { title: "T", body: "B", data: { key: "payment.sent", params: { payee: 1 } } },
        t,
        money
      )
    ).toEqual({ title: "T", body: "B" });
    expect(
      notificationText({ title: "T", body: "B", data: { key: "other", params: {} } }, t, money)
    ).toEqual({ title: "T", body: "B" });
  });

  it("finds reason codes in data or params", () => {
    expect(notificationReasonCodes({ data: { reasonCodes: ["A"] } })).toEqual(["A"]);
    expect(notificationReasonCodes({ data: { params: { reasonCodes: ["B"] } } })).toEqual(["B"]);
    expect(notificationReasonCodes({ data: null })).toEqual([]);
  });
});
