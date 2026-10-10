import { describe, expect, it } from "@jest/globals";
import { CanonicalOrder, formatMoney, orderHash } from "@kassa/shared";

// @kassa/shared is consumed from source through the bun workspace; this pins that it resolves and
// hashes identically under the app's toolchain (the golden vector lives in packages/shared/test).
describe("@kassa/shared in the app", () => {
  it("hashes the golden order and formats money", () => {
    const order = CanonicalOrder.parse({
      v: 1,
      proposalId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
      userId: "3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f",
      payeeId: "c0ffee00-1234-4abc-8def-0123456789ab",
      payeeName: "Budapest University (simulated)",
      payeeAccountHash: "q0VZ3x1hR0bWm9v1qk8yJbG0f3l8bVt7S0m5yQwzX1A",
      amountMinor: 240000,
      currency: "EUR",
      rail: "BANK_TRANSFER",
      purpose: "Tuition autumn term, ref STU-2026-0042",
      homeAmountMinor: 141600000,
      homeCurrency: "KZT",
      mandateId: null,
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      expiresAt: "2026-10-31T10:10:00.000Z",
    });
    expect(orderHash(order)).toBe("HcTIt8V3lJtv4mLSbog0Y2T05LuyRI0rAPlLUZrBZ4k");
    expect(formatMoney(240000, "EUR")).toBe("€2,400.00");
  });
});
