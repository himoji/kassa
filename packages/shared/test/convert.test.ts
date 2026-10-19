/*
 * (2026-10-18) CONVERT orders (own balance → own balance) and the one-sentence signed order (orderLineEn).
 */
import { describe, expect, it } from "vitest";

import { orderConversion, type CanonicalOrder, orderHash, orderLineEn, orderLineStance, ownWalletAccountHash, OWN_WALLET_PAYEE_NAME } from "../src/index.ts";

const USER = "3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f";
const CONVERT: CanonicalOrder = {
  v: 1,
  proposalId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
  userId: USER,
  payeeId: USER,
  payeeName: OWN_WALLET_PAYEE_NAME,
  payeeAccountHash: ownWalletAccountHash(USER),
  amountMinor: 210_050,
  currency: "EUR",
  rail: "CONVERT",
  purpose: "Convert KZT to EUR",
  homeAmountMinor: 128_634_620,
  homeCurrency: "KZT",
  mandateId: null,
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  expiresAt: "2026-10-31T10:10:00.000Z",
  fundingCurrency: "KZT",
  fundingAmountMinor: 130_000_000,
  fundingRouteId: "kzt-mock-bank",
  fundingMarkupBps: 55,
};

describe("CONVERT canonical orders", () => {
  it("own wallet → own wallet with a funding binding hashes, and reads back as a conversion", () => {
    expect(orderHash(CONVERT)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(orderConversion(CONVERT)).toEqual({ fromCurrency: "KZT", maxDebitMinor: 130_000_000, toCurrency: "EUR", amountMinor: 210_050, routeId: "kzt-mock-bank", markupBps: 55 });
  });

  it("the wallet hash is per user: another user's wallet, or a payee, is never a conversion target", () => {
    expect(ownWalletAccountHash(USER)).not.toBe(ownWalletAccountHash("c0ffee00-1234-4abc-8def-0123456789ab"));
    expect(() => orderHash({ ...CONVERT, payeeAccountHash: ownWalletAccountHash("c0ffee00-1234-4abc-8def-0123456789ab") })).toThrow(/own wallet/);
    expect(() => orderHash({ ...CONVERT, payeeId: "c0ffee00-1234-4abc-8def-0123456789ab" })).toThrow(/own wallet/);
  });

  it("refuses to hash a conversion without funding, within one currency, or carrying a mandate, bill, items, PO or linked account", () => {
    const { fundingCurrency: _c, fundingAmountMinor: _a, fundingRouteId: _r, fundingMarkupBps: _m, ...unfunded } = CONVERT;
    expect(() => orderHash(unfunded as CanonicalOrder)).toThrow(/funding binding/);
    expect(() => orderHash({ ...CONVERT, fundingCurrency: "EUR" })).toThrow(/two different currencies/);
    expect(() => orderHash({ ...CONVERT, mandateId: "c0ffee00-1234-4abc-8def-0123456789ab" })).toThrow(/carries no/);
    expect(() => orderHash({ ...CONVERT, obligationId: "c0ffee00-1234-4abc-8def-0123456789ab", obligationPeriod: "2026-11-01" })).toThrow(/carries no/);
    expect(() => orderHash({ ...CONVERT, itemsHash: "x" })).toThrow(/carries no/);
    expect(() => orderHash({ ...CONVERT, fundingSourceId: "c0ffee00-1234-4abc-8def-0123456789ab" })).toThrow(/carries no/);
  });

  it("other rails are not conversions", () => {
    expect(orderConversion({ ...CONVERT, rail: "BANK_TRANSFER" })).toBeNull();
  });
});

describe("orderLineEn: the signed order in one sentence", () => {
  it("a conversion names both balances, the amount bought and the signed maximum", () => {
    expect(orderLineEn(CONVERT)).toBe("Order to sign: convert from your KZT balance into EUR 2,100.50 in your EUR balance, debiting at most KZT 1,300,000.00 incl. fees (route kzt-mock-bank).");
  });

  it("a payment names the funding balance it is signed with (the judge's insurance case: HUF, not EUR)", () => {
    const pay: CanonicalOrder = {
      ...CONVERT,
      rail: "BANK_TRANSFER",
      payeeId: "c0ffee00-1234-4abc-8def-0123456789ab",
      payeeName: "Insurer Ltd",
      payeeAccountHash: "q0VZ3x1hR0bWm9v1qk8yJbG0f3l8bVt7S0m5yQwzX1A",
      amountMinor: 8_950,
      fundingCurrency: "HUF",
      fundingAmountMinor: 3_532_745,
      fundingRouteId: "huf-mock-bank",
      fundingMarkupBps: 35,
    };
    expect(orderLineEn(pay, "SIGNED")).toBe("Signed order: EUR 89.50 to Insurer Ltd, funded from your HUF balance: at most HUF 35,327.45 incl. fees (route huf-mock-bank).");
    const { fundingCurrency: _c, fundingAmountMinor: _a, fundingRouteId: _r, fundingMarkupBps: _m, ...card } = pay;
    expect(orderLineEn({ ...(card as CanonicalOrder), rail: "CARD_ISSUING" }, "PAID_SMALL_AUTO")).toBe("Paid under your small-payment limit: EUR 89.50 to Insurer Ltd, with a one-time card.");
    expect(orderLineEn(pay, "PAID_MANDATE").startsWith("Paid under your mandate: EUR 89.50 to Insurer Ltd")).toBe(true);
  });
});

describe("orderLineStance: never \"signed\" before the passkey (2026-10-19)", () => {
  const withMandate = { mandateId: "c0ffee00-1234-4abc-8def-0123456789ab" };
  const noMandate = { mandateId: null };
  it("by decision and status", () => {
    expect(orderLineStance("ASK", "PENDING_APPROVAL", noMandate)).toBe("TO_SIGN");
    expect(orderLineStance("HANDOFF", "PENDING_APPROVAL", noMandate)).toBe("TO_SIGN");
    expect(orderLineStance("ASK", "EXECUTED", noMandate)).toBe("SIGNED");
    expect(orderLineStance("ASK", "APPROVED", noMandate)).toBe("SIGNED");
    expect(orderLineStance("AUTO", "EXECUTED", withMandate)).toBe("PAID_MANDATE");
    expect(orderLineStance("AUTO", "EXECUTED", noMandate)).toBe("PAID_SMALL_AUTO");
    // An AUTO order whose payment failed was not paid.
    expect(orderLineStance("AUTO", "FAILED", withMandate)).toBe("ORDER");
    expect(orderLineStance("ASK", "REJECTED", noMandate)).toBe("ORDER");
    expect(orderLineStance("ASK", "EXPIRED", noMandate)).toBe("ORDER");
    // A refused order has no order line at all.
    expect(orderLineStance("REFUSE", "REFUSED", noMandate)).toBeNull();
  });
});
