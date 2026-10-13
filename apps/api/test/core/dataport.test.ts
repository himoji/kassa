/* Data import / export (dataport): mapping arbitrary JSON, committing it safely, and the kassa-export round trip. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { budgets, cards, obligations, payees, transactions } from "../../src/db/schema.ts";
import { fieldFor, mapImport, parseAmount, parseDate } from "../../src/modules/dataport/mapper.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const GERMAN_BANK = {
  konto: "DE12…",
  waehrung: "EUR",
  umsaetze: [
    { Buchungsdatum: "03.10.2026", Empfaenger: "REWE Markt", Betrag: "-23,45", Kategorie: "Groceries" },
    { Buchungsdatum: "28.09.2026", Empfaenger: "Arbeitgeber GmbH", Betrag: "1.850,00" },
    { Buchungsdatum: "15.09.2026", Empfaenger: "Deutsche Bahn", Betrag: "-1.249,90" },
  ],
};

const APP_EXPORT = {
  data: {
    transactions: [
      { id: 1, created_at: 1791500000, amount: { value: 12.5, currency: "USD" }, description: "Coffee Shop", type: "card_payment", card: "**** 4821" },
      { id: 2, created_at: 1791600000, amount: { value: 3200, currency: "JPY" }, description: "Lawson", type: "card_payment" },
      { id: 3, created_at: 1791700000, amount: { value: 50, currency: "USD" }, description: "Top up", type: "topup" },
    ],
    cards: [{ name: "Travel card", last4: "4821", currency: "USD" }],
  },
};

describe("import mapping", () => {
  it("reads field names in other languages and fuzzy variants", () => {
    expect(fieldFor("Buchungsdatum")).toBe("date");
    expect(fieldFor("Betrag")).toBe("amount");
    expect(fieldFor("Сумма")).toBe("amount");
    expect(fieldFor("transaction_amount_eur")).toBe("amount");
    expect(fieldFor("ammount")).toBe("amount");
    expect(fieldFor("amount.currency")).toBe("currency");
    expect(fieldFor("colour")).toBeNull();
  });

  it("parses amounts and dates in any common style", () => {
    expect(parseAmount("-1.249,90", "EUR", false)).toBe(-124990);
    expect(parseAmount("1 234,5 Ft", "HUF", false)).toBe(123450);
    expect(parseAmount(12.5, "USD", false)).toBe(1250);
    expect(parseAmount(3200, "JPY", false)).toBe(3200);
    expect(parseAmount("(15.00)", "USD", false)).toBe(-1500);
    expect(parseDate("03.10.2026", true)?.toISOString().slice(0, 10)).toBe("2026-10-03");
    expect(parseDate("10/31/2026", false)?.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(parseDate(1791500000, true)?.getUTCFullYear()).toBe(2026);
  });

  it("maps a German bank statement: spending only, signs, a decimal comma, the document's currency", () => {
    const p = mapImport(JSON.stringify(GERMAN_BANK), "KZT");
    expect(p.source).toBe("mapped");
    expect(p.mappings[0]).toMatchObject({ path: "$.umsaetze", kind: "transactions", rows: 3, imported: 2 });
    expect(p.mappings[0]!.fields).toMatchObject({ date: "Buchungsdatum", amount: "Betrag", merchant: "Empfaenger" });
    expect(p.items.transactions).toEqual([
      expect.objectContaining({ merchant: "REWE Markt", amountMinor: 2345, currency: "EUR", category: "groceries", occurredAt: expect.stringMatching(/^2026-10-03/) }),
      expect.objectContaining({ merchant: "Deutsche Bahn", amountMinor: 124990, currency: "EUR" }),
    ]);
    expect(p.warnings.join(" ")).toMatch(/1 incoming payments/);
  });

  it("maps a nested app export: per-row currencies, epoch dates, card digits, top-ups left out, cards found", () => {
    const p = mapImport(JSON.stringify(APP_EXPORT), "EUR");
    expect(p.items.transactions.map((x) => [x.merchant, x.amountMinor, x.currency, x.cardLast4])).toEqual([
      ["Coffee Shop", 1250, "USD", "4821"],
      ["Lawson", 3200, "JPY", null],
    ]);
    expect(p.items.cards).toEqual([{ label: "Travel card", last4: "4821", billingCurrency: "USD", kind: "USD" }]);
  });

  it("finds bills and budgets", () => {
    const p = mapImport(
      JSON.stringify({
        subscriptions: [{ name: "Dorm rent", price: "120000", currency: "HUF", next_payment: "2026-11-01", frequency: "monthly" }],
        budgets: [{ category: "Eating out", limit: 40000 }],
      }),
      "KZT",
    );
    expect(p.items.bills).toEqual([expect.objectContaining({ payeeName: "Dorm rent", payeeKind: "LANDLORD", amountMinor: 12000000, currency: "HUF", dueDate: "2026-11-01", recurrence: "MONTHLY" })]);
    expect(p.items.budgets).toEqual([{ category: "eating_out", limitHomeMinor: 4000000 }]);
  });

  it("says clearly when a file is not usable", () => {
    expect(() => mapImport("{nope", "EUR")).toThrow(/not valid JSON/);
    expect(() => mapImport(JSON.stringify({ hello: "world" }), "EUR")).toThrow(/No spending/);
  });
});

describe("import commit and export", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("imports spending without duplicates, bills as unpayable placeholders, cards; never budgets; export round-trips", async () => {
    const { userId } = await createUserWithPasskey();
    const headers = await bearer(userId);
    const preview = await app().inject({ method: "POST", url: "/api/import/preview", headers, payload: { text: JSON.stringify(GERMAN_BANK) } });
    expect(preview.statusCode).toBe(200);
    const items = {
      ...preview.json().items,
      bills: [{ payeeName: "Studentenwerk", payeeKind: "LANDLORD", amountMinor: 35000, currency: "EUR", dueDate: "2026-11-01", recurrence: "MONTHLY", category: "rent" }],
      cards: [{ label: "Girokarte", last4: "1234", billingCurrency: "EUR", kind: "LOCAL_HUF" }],
      budgets: [{ category: "groceries", limitHomeMinor: 99999999 }],
    };
    const first = await app().inject({ method: "POST", url: "/api/import/commit", headers, payload: { items } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ transactions: { imported: 2, duplicates: 0, failed: 0 }, bills: { added: 1, skipped: 0 }, cards: { added: 1, skipped: 0 } });
    const again = await app().inject({ method: "POST", url: "/api/import/commit", headers, payload: { items } });
    expect(again.json()).toEqual({ transactions: { imported: 0, duplicates: 2, failed: 0 }, bills: { added: 0, skipped: 1 }, cards: { added: 0, skipped: 1 } });

    const rows = await getDb().select().from(transactions).where(eq(transactions.userId, userId));
    expect(rows.map((r) => r.source)).toEqual(["IMPORT", "IMPORT"]);
    expect(rows.find((r) => r.merchantRaw === "REWE Markt")?.category).toBe("groceries");
    const payee = (await getDb().select().from(payees).where(eq(payees.userId, userId)))[0]!;
    expect(payee).toMatchObject({ name: "Studentenwerk", status: "COOLING", accountHash: null });
    expect(await getDb().select().from(budgets).where(eq(budgets.userId, userId))).toHaveLength(0);

    const exported = await app().inject({ method: "GET", url: "/api/export", headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toMatch(/kassa-export-/);
    const doc = exported.json();
    expect(doc).toMatchObject({ format: "kassa-export", version: 1, cards: [{ last4: "1234" }], bills: [{ payeeName: "Studentenwerk" }] });
    expect(doc.transactions).toHaveLength(2);

    // Another account imports the export exactly.
    const other = await createUserWithPasskey();
    const oh = await bearer(other.userId);
    const p2 = await app().inject({ method: "POST", url: "/api/import/preview", headers: oh, payload: { text: JSON.stringify(doc) } });
    expect(p2.json().source).toBe("kassa");
    const c2 = await app().inject({ method: "POST", url: "/api/import/commit", headers: oh, payload: { items: p2.json().items } });
    expect(c2.json().transactions.imported).toBe(2);
    expect(await getDb().select().from(cards).where(eq(cards.userId, other.userId))).toHaveLength(1);
    expect(await getDb().select().from(obligations).where(eq(obligations.userId, other.userId))).toHaveLength(1);
  });

  it("unreadable files answer 422 with the reason", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/import/preview", headers: await bearer(userId), payload: { text: "[1,2,3]" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/No spending/);
  });
});
