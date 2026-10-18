/*
 * Reader plausibility checks (evidence.ts, I10) on the 30 labelled invoices (fixtures/invoices/): every wrong value
 * the live eval still marked VERIFIED (docs/evidence/invoice-eval.json "wrongButVerified") is now UNVERIFIED, and
 * every ground-truth value, with the document line it is printed on as evidence, still verifies.
 */
import { readFileSync } from "node:fs";

import { buildIban } from "@kassa/shared";
import { beforeAll, describe, expect, it } from "vitest";

import type { InvoiceField, InvoiceLabel, InvoiceOutcome } from "../../src/modules/reader/eval.ts";
import { checkAccount, checkCurrency, checkField, checkReference, isAccountHolderName, labelledReferences, normalizeAccount, numberReadings } from "../../src/modules/reader/evidence.ts";
import { pdfToText } from "../../src/modules/reader/extract.ts";
import { verifyExtraction } from "../../src/modules/reader/reader.ts";

const root = new URL("../../../../", import.meta.url);
const { invoices } = JSON.parse(readFileSync(new URL("fixtures/invoices/labels.json", root), "utf8")) as { invoices: InvoiceLabel[] };
const evalReport = JSON.parse(readFileSync(new URL("docs/evidence/invoice-eval.json", root), "utf8")) as { results: InvoiceOutcome[] };
/** The demo user the invoices are billed to (modules/demo/seed.ts). */
const HOLDER = ["Dana"];

const texts = new Map<string, string>();
beforeAll(async () => {
  for (const l of invoices) texts.set(l.id, await pdfToText(new Uint8Array(readFileSync(new URL(`fixtures/invoices/${l.file}`, root)))));
});

const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();
const lines = (id: string) => texts.get(id)!.split("\n").filter((l) => l.trim());
/** The first document line that prints `value` (the evidence a faithful Reader would copy). */
function lineWith(id: string, pred: (line: string) => boolean): string {
  const l = lines(id).find(pred);
  if (!l) throw new Error(`${id}: no line for value`);
  return l;
}

function check(id: string, field: InvoiceField, value: string, evidence: string) {
  const label = invoices.find((l) => l.id === id)!;
  const type = field === "payeeName" ? "payee" : field === "reference" ? "reference" : field === "accountNumber" ? "account" : field === "dueDate" ? "date" : field;
  return checkField(type, { value, evidence }, texts.get(id)!, { currency: label.currency, accountHolderNames: HOLDER, amount: label.amount, account: label.accountNumber });
}

describe("wrong values the eval verified are now rejected", () => {
  const wrong = evalReport.results.flatMap((r) =>
    (Object.entries(r.fields) as [InvoiceField, InvoiceOutcome["fields"][InvoiceField]][])
      .filter(([, f]) => f.verified && !f.match && f.got !== null)
      .map(([field, f]) => ({ id: r.id, field, got: f.got! })),
  );

  it("the eval lists the 4 references and 2 payee names", () => {
    expect(wrong.map((w) => `${w.id}:${w.field}`).sort()).toEqual(
      ["inv-02:reference", "inv-03:payeeName", "inv-13:reference", "inv-16:payeeName", "inv-18:reference", "inv-21:reference"].sort(),
    );
  });

  it.each([
    ["inv-02", "reference", "HF-2026/0311", /Közlemény/],
    ["inv-13", "reference", "SKO-261101", /no payment reference/],
    ["inv-18", "reference", "No payment reference required", /no payment reference/],
    ["inv-21", "reference", "HEC-26-551", /Verwendungszweck/],
    ["inv-03", "payeeName", "Dana Seitkali", /account holder/],
    ["inv-16", "payeeName", "Dana Seitkali", /account holder/],
  ] as const)("%s %s %j → UNVERIFIED", (id, field, got, why) => {
    expect(wrong).toContainEqual({ id, field, got });
    // Best case for the Reader: the evidence is the real document line that prints the value.
    const evidence = lineWith(id, (l) => squash(l).includes(squash(got)));
    const r = check(id, field, got, evidence);
    expect(r.check).toBe("UNVERIFIED");
    expect(r.why).toMatch(why);
  });

  it("the payee flag reaches the result as a non-critical failure (the user is asked), amount and account untouched", () => {
    const label = invoices.find((l) => l.id === "inv-03")!;
    const src = texts.get("inv-03")!;
    const r = verifyExtraction(
      "invoice",
      {
        payeeName: { value: "Dana Seitkali", evidence: "Dana Seitkali" },
        accountNumber: { value: label.accountNumber, evidence: lineWith("inv-03", (l) => l.startsWith("IBAN")) },
        reference: { value: label.reference, evidence: lineWith("inv-03", (l) => l.startsWith("Payment reference")) },
        amount: { value: label.amount, evidence: "Amount due €96.00" },
        currency: { value: "EUR", evidence: "Amount due €96.00" },
        dueDate: { value: label.dueDate, evidence: "Due date 15/11/2026" },
      },
      src,
      "pdf",
      "t",
      { accountHolderNames: HOLDER },
    );
    expect(r.fields.payeeName!.check).toBe("UNVERIFIED");
    expect(r.checks.failures.payeeName).toMatch(/account holder/);
    expect(r.reasonCodes).toEqual(["READER_FIELD_UNVERIFIED"]);
    expect(r.checks.amount).toBe("VERIFIED");
    expect(r.checks.account).toBe("VERIFIED");
    // Without the holder's names (no signed-in user), the name check alone cannot tell.
    const anon = verifyExtraction("invoice", { payeeName: { value: "Dana Seitkali", evidence: "Dana Seitkali" } }, src, "pdf", "t");
    expect(anon.fields.payeeName!.check).toBe("VERIFIED");
  });
});

describe("ground truth of all 30 invoices still verifies", () => {
  it.each(invoices.map((l) => [l.id, l] as const))("%s", (id, label) => {
    const payeeLine = lineWith(id, (l) => l.includes(label.payeeName));
    expect(check(id, "payeeName", label.payeeName, payeeLine), "payeeName").toMatchObject({ check: "VERIFIED" });

    const ibanLine = lineWith(id, (l) => normalizeAccount(l).includes(label.accountNumber));
    expect(check(id, "accountNumber", label.accountNumber, ibanLine), "accountNumber").toMatchObject({ check: "VERIFIED" });

    const amountLine = [...lines(id)].reverse().find((l) => numberReadings(l).some((r) => Number(r) === Number(label.amount)) && checkCurrency(label.currency, l).ok)!;
    expect(amountLine, "amount line").toBeDefined();
    expect(check(id, "amount", label.amount, amountLine), "amount").toMatchObject({ check: "VERIFIED", amountMinor: label.amountMinor });
    expect(check(id, "currency", label.currency, amountLine), "currency").toMatchObject({ check: "VERIFIED" });

    if (label.reference !== null) {
      const ref = label.reference;
      const all = lines(id);
      const i = all.findIndex((l) => squash(l).includes(squash(ref)) && labelledReferences(l).length > 0);
      // Stacked layouts print the value on the line after its label.
      const evidence = i >= 0 ? all[i]! : lineWith(id, (l) => squash(l).includes(squash(ref)));
      expect(check(id, "reference", ref, evidence), "reference").toMatchObject({ check: "VERIFIED" });
    }
  });
});

describe("reference format checks", () => {
  const SRC = "Invoice no. INV-7\nIBAN HU83 1180 0990 5400 2217 0000 0005\nAmount due EUR 2,400.00\nDue date 31.10.2026";
  it.each([
    ["31.10.2026", "Due date 31.10.2026", /date/],
    ["2,400.00", "Amount due EUR 2,400.00", /amount/],
    ["2400", "Total 2400", /amount/],
    ["HU83 1180 0990 5400 2217 0000 0005", "IBAN HU83 1180 0990 5400 2217 0000 0005", /account/],
    ["Invoice no.", "Invoice no. INV-7", /label/],
  ])("%j is not a reference", (value, evidence, why) => {
    const r = checkReference(value, evidence, SRC, { amount: "2400.00", account: "HU83118009905400221700000005" });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(why);
  });

  it("an invoice number is the reference when no payment reference is printed; an RF reference is not an IBAN", () => {
    expect(checkReference("INV-7", "Invoice no. INV-7", SRC)).toEqual({ ok: true });
    const rf = "Reference: RF39 RUB2 026F 0421 7";
    expect(checkReference("RF39RUB2026F04217", rf, `${SRC}\n${rf}`)).toEqual({ ok: true });
  });

  it("a student ID label is a reference label", () => {
    const src = "Tuition invoice T-1\nStudent ID: NEP123\nAmount due EUR 10.00";
    expect(checkReference("T-1", "Tuition invoice T-1", src).ok).toBe(false);
    expect(checkReference("NEP123", "Student ID: NEP123", src)).toEqual({ ok: true });
  });
});

describe("account holder name match", () => {
  it.each([
    ["Dana Seitkali", ["Dana"], true],
    ["SEITKALI, Dana", ["Dana Seitkali"], true],
    ["Dana", ["Dana Seitkali"], true],
    ["Dána Seitkali", ["Dana Seitkali"], true],
    ["University in Budapest", ["Dana"], false],
    ["Dana Bakery Budapest Kft", ["Dana"], false],
    ["Anything", [], false],
  ] as const)("%j vs %j → %s", (name, holders, expected) => {
    expect(isAccountHolderName(name, holders)).toBe(expected);
  });
});

describe("amount, currency and account evidence are exact", () => {
  const IBAN = buildIban("HU", "117730161111101800000000");
  const printed = IBAN.replace(/(.{4})(?=.)/g, "$1 ");
  it("a truncated IBAN or account number is not verified", () => {
    expect(checkAccount(IBAN, `IBAN ${printed}`).ok).toBe(true);
    expect(checkAccount(IBAN.slice(0, 14), `IBAN ${printed}`)).toMatchObject({ ok: false, why: /IBAN/ });
    expect(checkAccount("11773016-11111018", "Account 11773016-11111018-00000000")).toMatchObject({ ok: false, why: /part/ });
    expect(checkAccount("11773016-11111018-00000000", "Account 11773016-11111018-00000000").ok).toBe(true);
  });
  it("currency codes count only as whole tokens", () => {
    expect(checkCurrency("EUR", "Total 96.00 EUR").ok).toBe(true);
    expect(checkCurrency("EUR", "€96.00").ok).toBe(true);
    expect(checkCurrency("HUF", "12 900 Ft").ok).toBe(true);
    expect(checkCurrency("HUF", "12 900Ft").ok).toBe(true);
    expect(checkCurrency("EUR", "Europa Kft 96.00").ok).toBe(false);
    expect(checkCurrency("HUF", "Gift 96.00").ok).toBe(false);
    expect(checkCurrency("USD", "C$96.00").ok).toBe(false);
    expect(checkCurrency("USD", "US$96.00").ok).toBe(true);
  });
  it("an amount must be the number in its evidence", () => {
    expect(check("inv-13", "amount", "105.91", "Zahlbetrag 105,91 €").check).toBe("VERIFIED");
    expect(check("inv-13", "amount", "105.90", "Zahlbetrag 105,91 €").check).toBe("UNVERIFIED");
  });
});
