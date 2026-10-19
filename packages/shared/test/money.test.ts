import { describe, expect, it } from "vitest";

import fxFixture from "../../../fixtures/fx-rates.json" with { type: "json" };
import { currencyExponent, FEATURED_CURRENCIES, formatMoney, fromMinor, isKnownCurrency, toMinor, WALLET_CURRENCIES } from "../src/index.ts";

describe("currency exponents", () => {
  it("uses ISO 4217 exponents", () => {
    for (const c of ["KZT", "HUF", "EUR", "USD", "CNY"]) expect(currencyExponent(c)).toBe(2);
    expect(() => currencyExponent("XXX")).toThrow(RangeError);
  });
});

describe("wallet currencies", () => {
  it("are exactly the currencies of the offline example rate table, all known ISO codes, demo currencies first", () => {
    expect([...WALLET_CURRENCIES].sort()).toEqual(Object.keys(fxFixture.rates).sort());
    expect(WALLET_CURRENCIES.length).toBeGreaterThan(100);
    for (const c of WALLET_CURRENCIES) expect(isKnownCurrency(c)).toBe(true);
    expect(WALLET_CURRENCIES.slice(0, FEATURED_CURRENCIES.length)).toEqual([...FEATURED_CURRENCIES]);
    for (const c of ["CUP", "IRR", "KPW", "SYP"]) expect(WALLET_CURRENCIES).not.toContain(c);
  });
});

describe("toMinor", () => {
  it("parses decimal strings exactly", () => {
    expect(toMinor("12.34", "EUR")).toBe(1234);
    expect(toMinor("0.1", "USD")).toBe(10);
    expect(toMinor("2400", "EUR")).toBe(240000);
    expect(toMinor("-5.5", "HUF")).toBe(-550);
    expect(toMinor("-0", "HUF")).toBe(0);
    expect(toMinor("600000", "KZT")).toBe(60000000);
  });

  it("accepts numbers without float drift", () => {
    expect(toMinor(0.29, "EUR")).toBe(29); // 0.29 * 100 === 28.999999999999996
    expect(toMinor(1.15, "USD")).toBe(115);
    expect(toMinor(400, "USD")).toBe(40000);
  });

  it("refuses excess precision, junk and unsafe magnitudes", () => {
    expect(() => toMinor("1.005", "EUR")).toThrow(RangeError);
    expect(() => toMinor(0.1 + 0.2, "EUR")).toThrow(RangeError);
    expect(() => toMinor("1e3", "EUR")).toThrow(RangeError);
    expect(() => toMinor("12,34", "EUR")).toThrow(RangeError);
    expect(() => toMinor(Number.NaN, "EUR")).toThrow(RangeError);
    expect(() => toMinor("900719925474099.20", "EUR")).toThrow(RangeError);
  });
});

describe("fromMinor", () => {
  it("formats exact decimal strings", () => {
    expect(fromMinor(1234, "EUR")).toBe("12.34");
    expect(fromMinor(5, "EUR")).toBe("0.05");
    expect(fromMinor(0, "EUR")).toBe("0.00");
    expect(fromMinor(-550, "HUF")).toBe("-5.50");
    expect(fromMinor(60000000, "KZT")).toBe("600000.00");
  });

  it("round-trips with toMinor", () => {
    for (const n of [0, 1, 99, 100, 123456789, -42, Number.MAX_SAFE_INTEGER]) {
      expect(toMinor(fromMinor(n, "USD"), "USD")).toBe(n);
    }
  });

  it("rejects non-integers", () => {
    expect(() => fromMinor(12.5, "EUR")).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("formats via Intl with the ISO exponent", () => {
    expect(formatMoney(240000, "EUR", "en")).toBe("€2,400.00");
    expect(formatMoney(40000, "USD", "en-US")).toBe("$400.00");
    expect(formatMoney(18000000, "HUF", "en")).toMatch(/^HUF\s?180,000\.00$/);
    expect(formatMoney(90000000, "KZT", "en")).toMatch(/^KZT\s?900,000\.00$/);
  });

  it("defaults to English", () => {
    expect(formatMoney(1234, "EUR")).toBe(formatMoney(1234, "EUR", "en"));
  });
});
