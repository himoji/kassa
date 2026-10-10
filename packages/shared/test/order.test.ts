import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64url, CanonicalOrder, jcs, orderHash, sha256Base64url } from "../src/index.ts";

// Golden vector: change this object or the hash below only together with a CanonicalOrder `v` bump.
const ORDER: CanonicalOrder = {
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
};

const ORDER_JCS =
  '{"amountMinor":240000,"currency":"EUR","expiresAt":"2026-10-31T10:10:00.000Z",' +
  '"homeAmountMinor":141600000,"homeCurrency":"KZT","mandateId":null,"nonce":"AAECAwQFBgcICQoLDA0ODw",' +
  '"payeeAccountHash":"q0VZ3x1hR0bWm9v1qk8yJbG0f3l8bVt7S0m5yQwzX1A","payeeId":"c0ffee00-1234-4abc-8def-0123456789ab",' +
  '"payeeName":"Budapest University (simulated)","proposalId":"8a6e0804-2bd0-4672-b79d-d97027f9071a",' +
  '"purpose":"Tuition autumn term, ref STU-2026-0042","rail":"BANK_TRANSFER",' +
  '"userId":"3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f","v":1}';

const ORDER_HASH = "HcTIt8V3lJtv4mLSbog0Y2T05LuyRI0rAPlLUZrBZ4k";

const nodeHash = (s: string) => createHash("sha256").update(s, "utf8").digest("base64url");

describe("orderHash", () => {
  it("JCS sorts keys and emits no whitespace", () => {
    expect(jcs(ORDER)).toBe(ORDER_JCS);
  });

  it("matches the committed golden vector", () => {
    expect(orderHash(ORDER)).toBe(ORDER_HASH);
  });

  it("agrees with node:crypto over the same canonical bytes", () => {
    expect(orderHash(ORDER)).toBe(nodeHash(ORDER_JCS));
  });

  it("is independent of key insertion order", () => {
    const reversed = Object.fromEntries(Object.entries(ORDER).reverse()) as CanonicalOrder;
    expect(orderHash(reversed)).toBe(ORDER_HASH);
  });

  it("strips unknown keys before hashing", () => {
    const extra = { ...ORDER, agentNote: "pay quickly" } as CanonicalOrder;
    expect(orderHash(extra)).toBe(ORDER_HASH);
  });

  it("changes when any signed field changes", () => {
    expect(orderHash({ ...ORDER, amountMinor: 240001 })).not.toBe(ORDER_HASH);
    expect(orderHash({ ...ORDER, payeeAccountHash: "x" })).not.toBe(ORDER_HASH);
    expect(orderHash({ ...ORDER, nonce: "AAECAwQFBgcICQoLDA0OEA" })).not.toBe(ORDER_HASH);
  });

  it("refuses to hash an invalid order", () => {
    expect(() => orderHash({ ...ORDER, amountMinor: 12.5 })).toThrow();
    expect(() => orderHash({ ...ORDER, amountMinor: 0 })).toThrow();
    expect(() => orderHash({ ...ORDER, purpose: "x".repeat(141) })).toThrow();
    expect(() => orderHash({ ...ORDER, expiresAt: "tomorrow" })).toThrow();
  });

  it("hashes non-ASCII payee names as UTF-8", () => {
    const o = { ...ORDER, payeeName: "Қазақ Ұлттық Университеті 学校" };
    expect(orderHash(o)).toBe(nodeHash(jcs(CanonicalOrder.parse(o))));
  });
});

describe("base64url / sha256", () => {
  it("matches Buffer base64url for all tail lengths", () => {
    for (let len = 0; len < 40; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 255);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("sha256 of empty string (RFC 6234 vector)", () => {
    expect(sha256Base64url("")).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  it("jcs rejects lone surrogates and non-JSON roots", () => {
    expect(() => jcs({ a: "\ud800" })).toThrow();
    expect(() => jcs(undefined)).toThrow();
  });
});
