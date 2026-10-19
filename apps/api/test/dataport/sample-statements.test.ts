/*
 * The sample statements judges can upload (fixtures/statements/): each reads cleanly through the real importer, and the
 * history finds what the files were written to show, above all that the money from home is irregular.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sampleStatements } from "../../../../fixtures/statements/generate.ts";
import { previewImport } from "../../src/modules/dataport/read.ts";

const dir = new URL("../../../../fixtures/statements/", import.meta.url);
const file = (name: string) => ({ name, data: new Uint8Array(readFileSync(new URL(name, dir))) });
// Dana (fixtures/seed-data.ts): home currency KZT; no AI, so only the deterministic readers run.
const base = { homeCurrency: "KZT", today: "2026-10-19", aiAllowed: false, ai: "off" as const, profileName: "Dana Seitkali" };
const income = (p: Awaited<ReturnType<typeof previewImport>>, source: string) => p.history!.incomes.find((i) => i.source === source);

describe("sample statements (fixtures/statements)", () => {
  it("the committed files are what generate.ts writes", () => {
    const lf = (s: string) => s.replace(/\r\n/g, "\n");
    for (const f of sampleStatements()) expect(lf(readFileSync(new URL(f.name, dir), "utf8")), f.name).toBe(lf(f.text));
  });

  it("Kaspi-style KZT statement: every row read, purchases abroad with the tenge charged, the father's money irregular", async () => {
    const p = await previewImport([file("kaspi-gold-kzt.csv")], base);
    expect(p.files).toEqual([expect.objectContaining({ format: "csv", via: "records", bank: "Kaspi", accountCurrency: "KZT", cardLast4: "4821", rows: 110, from: "2025-10-15", to: "2026-10-15", rejected: 0 })]);
    expect(p.mappings).toEqual([expect.objectContaining({ rows: 110, imported: 110, fields: { date: "Күні", amount: "Сомасы", operation: "Операция", merchant: "Толығырақ" } })]);
    expect(p.warnings.filter((w) => /skipped|assumed/.test(w))).toEqual([]);
    expect(p.history?.counts).toMatchObject({ rows: 110, incoming: 13, ownTransfers: 14, refunds: 0 });
    // A purchase in Budapest: the shop's forint amount, settled in tenge.
    expect(p.items.transactions).toContainEqual(expect.objectContaining({ merchant: "VALUE MART 0412 BUDAPEST", currency: "HUF", amountMinor: 543000, settledCurrency: "KZT", settledAmountMinor: 860655 }));
    expect(new Set(p.items.transactions.map((t) => t.currency))).toEqual(new Set(["KZT", "HUF", "EUR"]));
    // Own transfers (to her Hungarian account, the Kaspi deposit) are not spending.
    expect(p.items.transactions.some((t) => /ДАНА|Депозит/i.test(t.merchant))).toBe(false);

    // The father: 8 of 12 months, ₸90,000–₸370,000; the ₸620,000 that paid the tuition deposit stays out of the plan.
    expect(income(p, "Нұрлан С.")).toMatchObject({
      regularity: "irregular",
      monthsReceived: 8,
      monthsCovered: 12,
      minMonthlyMinor: 9_000_000,
      maxMonthlyMinor: 37_000_000,
      stopped: false,
      largest: { date: "2026-08-24", amountMinor: 62_000_000, paidFor: "UNIVERSITY IN BUDAPEST" },
      amount: { amountMinor: 13_000_000, currency: "KZT" },
    });
    // The mother: 3 of 12 months, not planned as income.
    expect(income(p, "Гүлнар С.")).toMatchObject({ regularity: "occasional", monthsReceived: 3 });
    expect(p.items.incomes).toEqual([expect.objectContaining({ source: "Нұрлан С.", currency: "KZT", amountMinor: 13_000_000, cadence: "MONTHLY" })]);
    expect(p.history?.oneOffs.map((o) => o.name)).toEqual(["UNIVERSITY IN BUDAPEST", "AIR TICKETS ONLINE"]);
    expect(p.history?.notes.join("\n")).toMatch(/Нұрлан С\.: money came in 8 of 12 months.*plan with the average, ₸130,000 a month; ₸620,000 on Aug 24 paid for UNIVERSITY IN BUDAPEST/);
  });

  it("Hungarian HUF account history: year-first dates, rent as a monthly bill, own top-ups left out, the father's transfer as income", async () => {
    const p = await previewImport([file("hu-bank-huf.csv")], base);
    expect(p.files).toEqual([expect.objectContaining({ format: "csv", via: "records", accountCurrency: "HUF", rows: 216, from: "2025-10-15", to: "2026-10-15", rejected: 0 })]);
    expect(p.mappings).toEqual([expect.objectContaining({ rows: 216, imported: 216 })]);
    expect(p.warnings.filter((w) => /skipped|assumed/.test(w))).toEqual([]);
    expect(p.history?.counts).toMatchObject({ rows: 216, incoming: 1, ownTransfers: 22 });
    expect(new Set(p.items.transactions.map((t) => t.currency))).toEqual(new Set(["HUF"]));
    expect(p.items.transactions[0]).toMatchObject({ occurredAt: "2025-10-15T12:00:00.000Z", currency: "HUF" });
    expect(p.items.bills).toContainEqual(expect.objectContaining({ payeeName: "Landlord in Budapest", payeeKind: "LANDLORD", amountMinor: 18_000_000, currency: "HUF", dueDate: "2026-11-01", recurrence: "MONTHLY" }));
    // One transfer in a year on this account alone is a one-off, not an income to plan with.
    expect(income(p, "NURLAN SEITKALI")).toMatchObject({ regularity: "one_off", monthsReceived: 1, cadence: "ONCE" });
    expect(p.items.incomes).toEqual([]);
    expect(p.history?.fees.count).toBe(12);
  });

  it("USD account OFX: the statement's own period, a regular scholarship, transfers to her own account left out", async () => {
    const p = await previewImport([file("usd-account.ofx")], base);
    expect(p.files).toEqual([expect.objectContaining({ format: "ofx", via: "records", accountCurrency: "USD", rows: 50, from: "2025-10-15", to: "2026-10-15", rejected: 0 })]);
    expect(p.warnings.filter((w) => /skipped|assumed/.test(w))).toEqual([]);
    expect(p.history?.counts).toMatchObject({ rows: 50, incoming: 12, ownTransfers: 12 });
    expect(income(p, "EXAMPLE SCHOLARSHIP FUND STIPEND")).toMatchObject({ regularity: "regular", monthsReceived: 12, monthsCovered: 12, amount: { amountMinor: 40_000, currency: "USD" } });
    expect(p.items.incomes).toEqual([expect.objectContaining({ currency: "USD", amountMinor: 40_000, nextDate: "2026-11-01" })]);
  });

  it("all three together: the father across two banks and two currencies is still irregular, nothing counted twice", async () => {
    const p = await previewImport(["kaspi-gold-kzt.csv", "hu-bank-huf.csv", "usd-account.ofx"].map(file), base);
    expect(p.files.map((f) => [f.format, f.accountCurrency, f.rows])).toEqual([
      ["csv", "KZT", 110],
      ["csv", "HUF", 216],
      ["ofx", "USD", 50],
    ]);
    expect(p.history?.counts).toMatchObject({ rows: 376, incoming: 26, ownTransfers: 48 });
    // The forint transfer in January joins the tenge ones: 9 of 12 months, in tenge.
    expect(income(p, "Нұрлан С.")).toMatchObject({ regularity: "irregular", monthsReceived: 9, monthsCovered: 12, count: 11, amount: { currency: "KZT" } });
    expect(income(p, "NURLAN SEITKALI")).toBeUndefined();
    expect(p.items.incomes.map((i) => [i.source, i.currency])).toEqual([
      ["Нұрлан С.", "KZT"],
      ["EXAMPLE SCHOLARSHIP FUND STIPEND", "USD"],
    ]);
  });
});
