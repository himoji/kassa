import { describe, it, expect } from "vitest";

import { categorize, categoryFromMcc } from "../../src/modules/capture/categorize.ts";

describe("categoryFromMcc", () => {
  it.each([
    ["5411", "groceries"],
    ["5812", "eating_out"],
    ["4121", "transport"],
    ["8220", "tuition"],
    ["5813", "eating_out"],
    ["5422", "groceries"],
    ["4785", "transport"],
  ] as const)("MCC %s → %s", (mcc, expected) => {
    expect(categoryFromMcc(mcc)).toBe(expected);
  });

  it("null input → null", () => {
    expect(categoryFromMcc(null)).toBeNull();
  });

  it("non-numeric input → null", () => {
    expect(categoryFromMcc("abc")).toBeNull();
  });

  it("MCC outside every mapped range → null", () => {
    expect(categoryFromMcc("9999")).toBeNull();
  });
});

describe("categorize", () => {
  it("user correction wins over everything (source USER)", async () => {
    const r = await categorize({
      merchantNorm: "noodle bar in",
      merchantRaw: "NOODLE BAR IN BUDAPEST",
      mcc: "5411",
      userCategory: "books",
    });
    expect(r.category).toBe("books");
    expect(r.source).toBe("USER");
  });

  it("MCC beats the merchant dictionary (source MCC)", async () => {
    const r = await categorize({ merchantNorm: "noodle bar in", merchantRaw: "NOODLE BAR IN BUDAPEST", mcc: "5411" });
    expect(r.category).toBe("groceries");
    expect(r.source).toBe("MCC");
  });

  it("no MCC: dictionary entry is used (source DICTIONARY) and its MCC is returned", async () => {
    const r = await categorize({ merchantNorm: "noodle bar in", merchantRaw: "NOODLE BAR IN BUDAPEST" });
    expect(r.category).toBe("eating_out");
    expect(r.source).toBe("DICTIONARY");
    expect(r.mcc).toBe("5812");
  });

  it("unknown merchant + Reader fallback returning a valid category → READER", async () => {
    const r = await categorize({
      merchantNorm: "unknown clinic",
      merchantRaw: "UNKNOWN CLINIC",
      readerFallback: async () => "health",
    });
    expect(r.category).toBe("health");
    expect(r.source).toBe("READER");
  });

  it("Reader fallback returning an unknown category → other (DEFAULT)", async () => {
    const r = await categorize({
      merchantNorm: "unknown clinic",
      merchantRaw: "UNKNOWN CLINIC",
      readerFallback: async () => "not-a-category",
    });
    expect(r.category).toBe("other");
    expect(r.source).toBe("DEFAULT");
  });

  it("Reader fallback rejecting → other (DEFAULT)", async () => {
    const r = await categorize({
      merchantNorm: "unknown clinic",
      merchantRaw: "UNKNOWN CLINIC",
      readerFallback: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(r.category).toBe("other");
    expect(r.source).toBe("DEFAULT");
  });

  it("Reader fallback throwing synchronously → other (DEFAULT)", async () => {
    const r = await categorize({
      merchantNorm: "unknown clinic",
      merchantRaw: "UNKNOWN CLINIC",
      readerFallback: () => {
        throw new Error("model unavailable");
      },
    });
    expect(r.category).toBe("other");
    expect(r.source).toBe("DEFAULT");
  });

  it("no fallback and no match → other (DEFAULT)", async () => {
    const r = await categorize({ merchantNorm: "unknown clinic", merchantRaw: "UNKNOWN CLINIC" });
    expect(r.category).toBe("other");
    expect(r.source).toBe("DEFAULT");
  });
});
