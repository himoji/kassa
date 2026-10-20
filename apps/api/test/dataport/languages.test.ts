/*
 * English statements from Kazakh banks (Kaspi Gold lines, Alatau's multi-currency card tables), a blank shop currency
 * worked out from context, and right-to-left text. All people, cards and accounts here are fictitious.
 */
import { describe, expect, it } from "vitest";

import { classifyRows } from "../../src/modules/dataport/classify.ts";
import { normalizeText } from "../../src/modules/dataport/files.ts";
import { lineRows } from "../../src/modules/dataport/lines.ts";
import { mapRecordArrays } from "../../src/modules/dataport/mapper.ts";
import { previewImport } from "../../src/modules/dataport/read.ts";

const base = { homeCurrency: "KZT", today: "2026-10-20", aiAllowed: false, ai: "off" as const, profileName: "Dana Seitkali" };
const holders = { holders: [["Dana Seitkali"]] };

const KASPI_EN = `Kaspi Gold
balance statement for the period from 20.10.25 to 20.10.26
DANA SEITKALI Card number: *4821
Currency: KZT
Date Amount Transaction Details
18.10.26 - 300 000,00 ₸ Transfer to your To Kaspi Deposit
account
18.10.26 + 20 000,00 ₸ Replenishment Гүлнар С.
18.10.26 - 5 163,20 ₸ Purchases MCDONALD S DEUTSCHLAND
(- 10,00 EUR)
16.10.26 - 10 000,00 ₸ Transfers Арман Т.
29.08.26 - 149,00 ₸ Others Commission for transfer of other banks
29.08.26 - 9 000,00 ₸ Transfers ДАНА С., Alatau City Bank
16.10.26 + 601 800,00 ₸ Replenishment From Kaspi account KZ*5619
`;

describe("Kaspi Gold in English (text lines)", () => {
  it("reads the Transaction column: own transfers, fees, transfers to people, purchases abroad", () => {
    const { rows } = lineRows(KASPI_EN, { accountCurrency: "KZT", homeCurrency: "KZT", file: 0 });
    classifyRows(rows, holders);
    const by = (d: string) => rows.find((r) => r.description.startsWith(d))!;
    expect(rows).toHaveLength(7);
    expect(by("To Kaspi Deposit")).toMatchObject({ kind: "OWN_TRANSFER", description: "To Kaspi Deposit" });
    expect(by("Гүлнар")).toMatchObject({ kind: "INCOME", amountMinor: 2_000_000 });
    expect(by("MCDONALD")).toMatchObject({ kind: "PURCHASE", currency: "EUR", amountMinor: -1000, settled: { amountMinor: -516320, currency: "KZT" } });
    expect(by("Арман")).toMatchObject({ kind: "TRANSFER_OUT" });
    expect(by("Commission")).toMatchObject({ kind: "FEE" });
    expect(by("ДАНА С.")).toMatchObject({ kind: "OWN_TRANSFER" });
    expect(by("From Kaspi account")).toMatchObject({ kind: "OWN_TRANSFER" });
  });
});

const ALATAU_HEADER = ["Transaction\ndate", "Transaction\ncompletion date", "Operation", "Details", "Amount", "Transaction\ncurrency", "Income in\naccount currency", "Expense\nin\naccount\ncurrency"];
const row = (date: string, op: string, details: string, amount: string, cur: string, inc: string, exp: string) =>
  Object.fromEntries(ALATAU_HEADER.map((h, i) => [h, [`${date}\n12:00:00`, `${date}\n13:00:00`, op, details, amount, cur, inc, exp][i]]));

describe("Alatau City Bank in English (multi-currency card tables)", () => {
  const kzt = [
    row("16.10.2026", "Payment", "MUHASZ\nAuthorization code: 870656", "1 575", "HUF", "0", "2\n280.91"),
    row("16.10.2026", "Payment", "SPAR MAGYARORSZAG KFT", "1 605", "HUF", "0", "2 322.64"),
    row("15.10.2026", "Payment", "TONI VEGYESBOLT", "990", "", "0", "1\n432.52"),
    row("15.10.2026", "Fee", "Payment of commission: Regular Charge", "200", "KZT", "0", "200"),
    row("09.10.2026", "Commission", "Commission: Перевод с карты:400000******1234;получатель: Арман Т.; CASPKZKA;АО «Kaspi Bank»", "250", "KZT", "0", "250"),
    row("09.10.2026", "Operation", "Перевод с карты:400000******1234;получатель: Арман Т.; CASPKZKA;АО «Kaspi Bank»", "25 000", "KZT", "0", "25 000"),
    row("07.10.2026", "Replenishment", "Replenishment by phone number from Nurlan S.", "100 000", "KZT", "100 000", "0"),
    row("05.10.2026", "Replenishment", "Cash Deposit to Account via ATM: Пополнение через банкомат № 00120077", "45 500", "KZT", "45 500", "0"),
  ];
  // The USD sub-account mirrors the HUF purchase as a top-up and a payment that cancel out.
  const usd = [
    row("16.10.2026", "Replenishment", "MUHASZ", "1 575", "HUF", "4.92", "0"),
    row("16.10.2026", "Payment", "MUHASZ", "1 575", "HUF", "0", "4.92"),
  ];

  it("keeps the main-account charge, leaves out the sub-account mirror, finds the blank currency", () => {
    const m = mapRecordArrays(
      [
        { path: "kzt", rows: kzt, accountCurrency: "KZT" },
        { path: "usd", rows: usd, accountCurrency: "USD" },
      ],
      { homeCurrency: "KZT", via: "table" },
    );
    expect(m.warnings).toEqual([]);
    classifyRows(m.rows, holders);
    const spending = m.rows.filter((r) => r.kind === "PURCHASE" || r.kind === "FEE" || r.kind === "TRANSFER_OUT");
    expect(spending.map((r) => [r.kind, r.description, r.amountMinor, r.currency, r.settled?.amountMinor ?? null])).toEqual([
      ["PURCHASE", "MUHASZ", -157500, "HUF", -228091],
      ["PURCHASE", "SPAR MAGYARORSZAG KFT", -160500, "HUF", -232264],
      // Blank currency: 990 against ₸1,432.52 is the HUF rate of the other rows.
      ["PURCHASE", "TONI VEGYESBOLT", -99000, "HUF", -143252],
      ["FEE", "Regular Charge", -20000, "KZT", null],
      ["FEE", "Арман Т., Kaspi Bank", -25000, "KZT", null],
      ["TRANSFER_OUT", "Арман Т., Kaspi Bank", -2500000, "KZT", null],
    ]);
    expect(m.rows.find((r) => r.description === "Nurlan S.")).toMatchObject({ kind: "INCOME" });
    expect(m.rows.find((r) => r.description.startsWith("Cash Deposit"))).toMatchObject({ kind: "OWN_TRANSFER" });
    expect(m.rows.filter((r) => r.currency === "HUF" && r.settled?.currency === "USD").every((r) => r.kind === "REFUND")).toBe(true);
  });

  it("one payment funded by two sub-account top-ups: neither half is income", () => {
    const m = mapRecordArrays(
      [
        { path: "kzt", rows: [row("13.07.2026", "Payment", "SHOP*frame", "566 704", "HUF", "0", "871\n837.48")], accountCurrency: "KZT" },
        {
          path: "usd",
          rows: [
            row("13.07.2026", "Replenishment", "SHOP*frame", "566 704", "HUF", "27.7", "0"),
            row("13.07.2026", "Replenishment", "SHOP*frame", "566 704", "HUF", "1 820.12", "0"),
            row("13.07.2026", "Payment", "SHOP*frame", "566 704", "HUF", "0", "1\n847.82"),
          ],
          accountCurrency: "USD",
        },
      ],
      { homeCurrency: "KZT", via: "table" },
    );
    classifyRows(m.rows, holders);
    expect(m.rows.map((r) => [r.kind, r.settled?.currency])).toEqual([
      ["PURCHASE", "KZT"],
      ["REFUND", "USD"],
      ["OWN_TRANSFER", "USD"],
      ["REFUND", "USD"],
    ]);
  });

  it("a blank currency with nothing to compare stays in the account currency, with the amount charged", () => {
    const m = mapRecordArrays([{ path: "kzt", rows: [row("15.10.2026", "Payment", "SHOP", "990", "", "0", "1 432.52")], accountCurrency: "KZT" }], { homeCurrency: "KZT", via: "table" });
    expect(m.rows[0]).toMatchObject({ amountMinor: -143252, currency: "KZT", settled: null });
    expect(m.warnings).toEqual(["1 rows had no currency; KZT (your home currency) was assumed."]);
  });
});

describe("printed signs", () => {
  it("a + amount stays money in even when the operation says Purchases (Kaspi FX credit)", () => {
    const rows = [
      { Date: "20.10.26", Amount: "+ 3,40 ₸", Transaction: "Purchases", Details: "SHOP Foreign exchange difference" },
      { Date: "18.10.26", Amount: "- 5 163,20 ₸", Transaction: "Purchases", Details: "SHOP" },
    ];
    const m = mapRecordArrays([{ path: "kaspi", rows, accountCurrency: "KZT" }], { homeCurrency: "KZT", via: "table" });
    classifyRows(m.rows, holders);
    expect(m.rows.map((r) => [r.amountMinor, r.kind])).toEqual([
      [340, "REFUND"],
      [-516320, "PURCHASE"],
    ]);
  });
});

describe("other languages and right-to-left text", () => {
  it("normalizes bidi marks and Arabic-Indic / Persian digits", () => {
    expect(normalizeText("‏١٢٫٥٠ ‫رسوم‬ ۳۴")).toBe("12.50 رسوم 34");
  });

  it("reads Arabic rows written date-last, with Arabic-Indic digits", async () => {
    const text = ["كشف حساب", "العملة: AED", "مشتريات كارفور ١٢٠٫٥٠- ١٥/٠٩/٢٠٢٦", "رسوم خدمة ١٠٫٠٠- ١٦/٠٩/٢٠٢٦", "إيداع راتب ٥٠٠٠٫٠٠+ ٢٠/٠٩/٢٠٢٦", "شراء مطعم ٤٥٫٠٠- ٢١/٠٩/٢٠٢٦"].join("\n");
    const p = await previewImport([{ name: "ar.txt", data: new TextEncoder().encode(text) }], { ...base, homeCurrency: "AED" });
    expect(p.files[0]).toMatchObject({ via: "lines", rows: 4 });
    expect(p.items.transactions.map((t) => [t.occurredAt.slice(0, 10), t.amountMinor, t.currency, t.category])).toEqual(
      expect.arrayContaining([
        ["2026-09-15", 12050, "AED", expect.any(String)],
        ["2026-09-16", 1000, "AED", "fees"],
        ["2026-09-21", 4500, "AED", expect.any(String)],
      ]),
    );
    expect(p.history?.counts.incoming).toBe(1);
  });

  it("maps Hebrew, Turkish and German column headers", async () => {
    const csv = (rows: string[][]) => new TextEncoder().encode(rows.map((r) => r.join(";")).join("\n"));
    for (const [lang, header] of [
      ["he", ["תאריך", "תיאור", "סכום", "מטבע"]],
      ["tr", ["Tarih", "Açıklama", "Tutar", "Para Birimi"]],
      ["de", ["Buchungsdatum", "Buchungstext", "Betrag", "Währung"]],
    ] as const) {
      const p = await previewImport([{ name: `${lang}.csv`, data: csv([[...header], ["01.09.2026", "SHOP ONE", "-12,50", "EUR"], ["02.09.2026", "SHOP TWO", "-30,00", "EUR"]]) }], base);
      expect(p.items.transactions.map((t) => [t.merchant, t.amountMinor, t.currency]), lang).toEqual([
        ["SHOP ONE", 1250, "EUR"],
        ["SHOP TWO", 3000, "EUR"],
      ]);
    }
  });
});
