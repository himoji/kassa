import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { parseAmountString, currencyFromText } from "../../src/modules/capture/amount.ts";
import { parseNotificationText, parseShortcut, ShortcutPayload } from "../../src/modules/capture/parsers/index.ts";
import { zonedToUtc } from "../../src/modules/capture/tz.ts";

interface NotificationSample {
  file: string;
  format: string;
  kind: string;
  expected: {
    merchant: string | null;
    amountMinor: number;
    currency: string;
    cardHint: string | null;
    time: string;
  };
}

interface NotificationIndex {
  samples: NotificationSample[];
}

const NOTIFICATIONS_DIR = new URL("../../../../fixtures/notifications/", import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, NOTIFICATIONS_DIR), "utf8");
}

const index = JSON.parse(readFixture("index.json")) as NotificationIndex;

describe("parseNotificationText against fixtures/notifications", () => {
  const textSamples = index.samples.filter((s) => s.file.endsWith(".txt"));

  it("has text samples to check", () => {
    expect(textSamples.length).toBeGreaterThan(0);
  });

  for (const sample of textSamples) {
    it(`parses ${sample.file}`, () => {
      const r = parseNotificationText(readFixture(sample.file));
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.merchantRaw).toBe(sample.expected.merchant);
      expect(r.amountMinor).toBe(sample.expected.amountMinor);
      expect(r.currency).toBe(sample.expected.currency);
      expect(r.cardHint).toBe(sample.expected.cardHint);
      expect(r.occurredAt?.getTime()).toBe(Date.parse(sample.expected.time));
      expect(r.kind).toBe(sample.kind);
      expect(r.format).toBe(sample.format);
    });
  }
});

describe("parseShortcut against the iOS Shortcut fixture", () => {
  it("parses ios-shortcut-transaction.json", () => {
    const payload = ShortcutPayload.parse(JSON.parse(readFixture("ios-shortcut-transaction.json")));
    const r = parseShortcut(payload);
    expect(r).not.toBeNull();
    expect(r?.format).toBe("IOS_SHORTCUT");
    expect(r?.kind).toBe("PURCHASE");
    expect(r?.merchantRaw).toBe("Grocery Store in Budapest");
    expect(r?.amountMinor).toBe(387000);
    expect(r?.currency).toBe("HUF");
    expect(r?.cardHint).toBe("Local HUF/EUR card");
    expect(r?.occurredAt?.getTime()).toBe(Date.parse("2026-10-13T20:00:00+02:00"));
  });
});

describe("parseNotificationText minimal strings", () => {
  it("KZ bank RU purchase with KZT, thin-space thousands and a Almaty-local time", () => {
    const r = parseNotificationText("Оплата: 12 500,00 KZT\nSMALL SHOP, ALMATY, KZ\nКарта: *1111\n01.10.2026 09:05");
    expect(r).not.toBeNull();
    expect(r?.format).toBe("KZ_BANK");
    expect(r?.kind).toBe("PURCHASE");
    expect(r?.amountMinor).toBe(1250000);
    expect(r?.currency).toBe("KZT");
    expect(r?.merchantRaw).toBe("SMALL SHOP");
    expect(r?.cardHint).toBe("1111");
    expect(r?.occurredAt?.getTime()).toBe(Date.parse("2026-10-01T09:05:00+05:00"));
  });

  it("KZ bank RU purchase with a thin space (U+2009) thousands separator", () => {
    const r = parseNotificationText("Оплата: 12 500,00 KZT\nSMALL SHOP, ALMATY, KZ\nКарта: *1111\n01.10.2026 09:05");
    expect(r?.amountMinor).toBe(1250000);
  });

  it("Alipay bank-SMS variant (…在<商户>消费35.50元)", () => {
    const r = parseNotificationText("您尾号1234的银行卡在美团外卖消费35.50元");
    expect(r).not.toBeNull();
    expect(r?.format).toBe("ALIPAY");
    // Expected: only the merchant between 在 and 消费. Reported separately if the parser includes extra text.
    expect(r?.merchantRaw).toBe("美团外卖");
    expect(r?.amountMinor).toBe(3550);
    expect(r?.currency).toBe("CNY");
    expect(r?.cardHint).toBe("1234");
  });

  it("Revolut with a currency code: 'Paid HUF 4,500 at SPAR'", () => {
    const r = parseNotificationText("Paid HUF 4,500 at SPAR");
    expect(r).not.toBeNull();
    expect(r?.format).toBe("REVOLUT");
    expect(r?.amountMinor).toBe(450000);
    expect(r?.currency).toBe("HUF");
    expect(r?.merchantRaw).toBe("SPAR");
  });

  it("Wise with decimals: 'You spent 12.50 EUR at Cafe Central.'", () => {
    const r = parseNotificationText("You spent 12.50 EUR at Cafe Central.");
    expect(r).not.toBeNull();
    expect(r?.format).toBe("WISE");
    expect(r?.amountMinor).toBe(1250);
    expect(r?.currency).toBe("EUR");
    expect(r?.merchantRaw).toBe("Cafe Central");
  });

  it("returns null for unrelated text", () => {
    expect(parseNotificationText("hello world")).toBeNull();
  });
});

describe("parseShortcut variants", () => {
  it("'€12.40' → 1240 EUR", () => {
    const r = parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "€12.40" }));
    expect(r?.amountMinor).toBe(1240);
    expect(r?.currency).toBe("EUR");
  });

  it("'HUF 4,500' → 450000 HUF", () => {
    const r = parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "HUF 4,500" }));
    expect(r?.amountMinor).toBe(450000);
    expect(r?.currency).toBe("HUF");
  });

  it("'1.234,56 €' → 123456 EUR", () => {
    const r = parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "1.234,56 €" }));
    expect(r?.amountMinor).toBe(123456);
    expect(r?.currency).toBe("EUR");
  });

  it("'12' with no currency uses the fallback currency", () => {
    const p = ShortcutPayload.parse({ merchant: "X", amount: "12" });
    const r = parseShortcut(p, "KZT");
    expect(r?.amountMinor).toBe(1200);
    expect(r?.currency).toBe("KZT");
  });

  it("'12' with no currency and no fallback returns null", () => {
    const p = ShortcutPayload.parse({ merchant: "X", amount: "12" });
    expect(parseShortcut(p)).toBeNull();
  });
});

describe("parseShortcut: what the iOS Transaction trigger actually sends", () => {
  const nbsp = "\u00a0";
  const narrow = "\u202f";
  it.each([
    ["1 290 Ft", 129000, "HUF"],
    [`1${nbsp}290${nbsp}Ft`, 129000, "HUF"],
    [`1${narrow}290,00${nbsp}Ft`, 129000, "HUF"],
    ["1.290 Ft", 129000, "HUF"],
    ["Ft 1,290", 129000, "HUF"],
    ["Ft1,290", 129000, "HUF"],
    ["HUF 1,290.00", 129000, "HUF"],
    ["HUF1,290.00", 129000, "HUF"],
    ["1 290,00 HUF", 129000, "HUF"],
    ["€4.50", 450, "EUR"],
    ["4,50 €", 450, "EUR"],
    ["EUR 4.50", 450, "EUR"],
    ["₸2 500", 250000, "KZT"],
    ["2 500 ₸", 250000, "KZT"],
    ["2 500 тг", 250000, "KZT"],
    ["¥38.00", 3800, "CNY"],
    ["CN¥38.00", 3800, "CNY"],
    ["38.00 元", 3800, "CNY"],
    ["$4.50", 450, "USD"],
    ["US$4.50", 450, "USD"],
    ["€4.50.", 450, "EUR"],
  ])("%j → %i %s", (amount, minor, currency) => {
    const r = parseShortcut(ShortcutPayload.parse({ merchant: "CAFE X", amount }), "KZT");
    expect(r?.amountMinor).toBe(minor);
    expect(r?.currency).toBe(currency);
    expect(r?.kind).toBe("PURCHASE");
  });

  it.each(["£4.50", "A$4.50", "JPY 500", "4.50 CHF", "abc", "€"])("%j (unsupported or no number) → null, never the home currency", (amount) => {
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount }), "HUF")).toBeNull();
  });

  it.each(["-€4.50", "€-4.50", "−1 290 Ft", "(€4.50)"])("%j is a refund, not spending", (amount) => {
    const r = parseShortcut(ShortcutPayload.parse({ merchant: "X", amount }), "HUF");
    expect(r?.kind).toBe("REFUND");
    expect(r?.amountMinor).toBeGreaterThan(0);
  });

  it("a Number-typed amount uses the explicit or fallback currency and rounds float noise", () => {
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: 1290 }), "HUF")).toMatchObject({ amountMinor: 129000, currency: "HUF" });
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: 4.499999999, currency: "eur" }), "HUF")).toMatchObject({ amountMinor: 450, currency: "EUR" });
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: 0 }), "HUF")).toBeNull();
  });

  it("an explicit currency wins over the symbol (¥ could be JPY)", () => {
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "¥38.00", currency: "CNY" }))?.currency).toBe("CNY");
  });

  it("a localized date is ignored (server time is used); ISO with an offset is kept", () => {
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "€1", date: "11 Oct 2026 at 10:59" }))?.occurredAt).toBeNull();
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "€1", date: "2026-10-11T10:59:00" }))?.occurredAt).toBeNull();
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "€1", date: "2026-10-11T10:59:00+02:00" }))?.occurredAt?.toISOString()).toBe("2026-10-11T08:59:00.000Z");
    expect(parseShortcut(ShortcutPayload.parse({ merchant: "X", amount: "€1", date: "2026-10-11T08:59:00Z" }))?.occurredAt?.toISOString()).toBe("2026-10-11T08:59:00.000Z");
  });

  it("an empty merchant is accepted as unknown; card name is kept as the hint", () => {
    const r = parseShortcut(ShortcutPayload.parse({ merchant: " ", amount: "€1", card: " Revolut ••4821 " }));
    expect(r?.merchantRaw).toBeNull();
    expect(r?.cardHint).toBe("Revolut ••4821");
    expect(parseShortcut(ShortcutPayload.parse({ amount: "€1" }))?.merchantRaw).toBeNull();
  });
});

describe("parseAmountString", () => {
  it.each([
    ["4 760,00", "HUF", "comma", 476000],
    ["1,290", "HUF", "dot", 129000],
    ["2.400,00", "EUR", "auto", 240000],
    ["2,400.00", "EUR", "auto", 240000],
    ["3 870", "HUF", "auto", 387000],
    ["12,5", "EUR", "auto", 1250],
  ] as const)("parses %s (%s, %s) → %i", (raw, currency, style, expected) => {
    expect(parseAmountString(raw, currency, style)).toBe(expected);
  });

  it("throws RangeError on a non-numeric string", () => {
    expect(() => parseAmountString("abc", "EUR")).toThrow(RangeError);
  });
});

describe("currencyFromText", () => {
  it.each([
    ["₸", "KZT"],
    ["3 870 Ft", "HUF"],
    ["€", "EUR"],
    ["¥45", "CNY"],
    ["US$5", "USD"],
    ["nothing", null],
  ] as const)("%s → %s", (text, expected) => {
    expect(currencyFromText(text)).toBe(expected);
  });
});

describe("zonedToUtc", () => {
  it("Europe/Budapest before DST end is UTC+2", () => {
    expect(zonedToUtc(2026, 10, 24, 12, 0, 0, "Europe/Budapest").toISOString()).toBe("2026-10-24T10:00:00.000Z");
  });

  it("Europe/Budapest after DST end (25 Oct 2026) is UTC+1", () => {
    expect(zonedToUtc(2026, 10, 26, 12, 0, 0, "Europe/Budapest").toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });

  it("Asia/Almaty is UTC+5 year-round", () => {
    expect(zonedToUtc(2026, 10, 26, 23, 50, 0, "Asia/Almaty").toISOString()).toBe("2026-10-26T18:50:00.000Z");
  });
});
