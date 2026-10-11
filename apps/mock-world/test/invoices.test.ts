import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PDFParse } from "pdf-parse";
import { describe, expect, it } from "vitest";

import { isValidIban, normalizeIban } from "@kassa/shared";

import { INVOICE_SPECS } from "../../../fixtures/invoices/source.ts";
import type { InvoiceSpec } from "../../../fixtures/invoices/source.ts";
import { type InvoiceLabel, type RenderedInvoice, renderInvoice } from "../src/pdf/invoice.ts";
import { renderPriceList } from "../src/pdf/priceList.ts";
import { PAYEE_INVOICES, SUPPLIERS } from "../src/world/data.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/invoices/", import.meta.url));

interface LabelsFile {
  invoices: InvoiceLabel[];
}

const labelsFile = JSON.parse(readFileSync(`${FIXTURE_DIR}labels.json`, "utf8")) as LabelsFile;
const labelsById = new Map(labelsFile.invoices.map((l) => [l.id, l]));

// ---------- helpers ----------

const rendered = new Map<string, Promise<RenderedInvoice>>();
function render(spec: InvoiceSpec): Promise<RenderedInvoice> {
  let p = rendered.get(spec.id);
  if (!p) {
    p = renderInvoice(spec);
    rendered.set(spec.id, p);
  }
  return p;
}

async function extractText(bytes: Uint8Array): Promise<string> {
  // pdf.js detaches the buffer it is given, so hand it a copy.
  const parser = new PDFParse({ data: bytes.slice() });
  const { text } = await parser.getText();
  await parser.destroy();
  return text;
}

const norm = (s: string): string => s.replace(/\s+/g, " ");

const CURRENCY_TOKENS = /EUR|USD|HUF|KZT|€|\$|Ft/g;

/** Printed amount -> ISO 4217 minor units, independent of the renderer's format helpers. */
function parseAmountMinor(printed: string): number {
  const s = printed.replace(CURRENCY_TOKENS, "").replace(/\s+/g, "");
  // The decimal separator is the last "," or "." followed by exactly two digits at the end.
  const m = /^(.*?)[.,](\d{2})$/.exec(s);
  const whole = (m ? m[1]! : s).replace(/[.,]/g, "");
  const frac = m ? Number(m[2]) : 0;
  return Number(whole) * 100 + frac;
}

const MONTH_NAMES = [
  // en
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  // de
  ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"],
  // hu
  ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"],
  // fr
  ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
];

function monthNumber(name: string): number {
  const n = name.toLowerCase();
  for (const list of MONTH_NAMES) {
    const i = list.indexOf(n);
    if (i >= 0) return i + 1;
  }
  throw new RangeError(`unknown month name: ${name}`);
}

function isoDate(y: string, m: number, d: string): string {
  return `${y}-${String(m).padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Printed due date (any of the nine date styles used by the layouts) -> ISO 8601 calendar date. */
function parseDate(printed: string): string {
  const s = printed.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return isoDate(m[1]!, Number(m[2]), m[3]!);
  if ((m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s))) return isoDate(m[3]!, Number(m[2]), m[1]!);
  if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) return isoDate(m[3]!, Number(m[2]), m[1]!);
  if ((m = /^(\d{4})\.(\d{2})\.(\d{2})\.$/.exec(s))) return isoDate(m[1]!, Number(m[2]), m[3]!);
  // hu-long: "2026. november 12."
  if ((m = /^(\d{4})\. (\p{L}+) (\d{1,2})\.$/u.exec(s))) return isoDate(m[1]!, monthNumber(m[2]!), m[3]!);
  // long-en "31 October 2026", fr-long "15 décembre 2026" / "1er décembre 2026"
  if ((m = /^(\d{1,2})(?:er)? (\p{L}+) (\d{4})$/u.exec(s))) return isoDate(m[3]!, monthNumber(m[2]!), m[1]!);
  // de-long "1. Dezember 2026"
  if ((m = /^(\d{1,2})\. (\p{L}+) (\d{4})$/u.exec(s))) return isoDate(m[3]!, monthNumber(m[2]!), m[1]!);
  // us-long "October 31, 2026"
  if ((m = /^(\p{L}+) (\d{1,2}), (\d{4})$/u.exec(s))) return isoDate(m[3]!, monthNumber(m[1]!), m[2]!);
  throw new RangeError(`unrecognised date: ${printed}`);
}

// ---------- labels file ----------

describe("labels.json", () => {
  it("has exactly 30 invoices, at least 6 layouts, at least 3 currencies and exactly 2 without a reference", () => {
    expect(labelsFile.invoices).toHaveLength(30);
    expect(new Set(labelsFile.invoices.map((l) => l.layout)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(labelsFile.invoices.map((l) => l.currency)).size).toBeGreaterThanOrEqual(3);
    expect(labelsFile.invoices.filter((l) => l.reference === null)).toHaveLength(2);
  });

  it("covers exactly the invoice specs", () => {
    expect(INVOICE_SPECS).toHaveLength(30);
    expect(new Set(INVOICE_SPECS.map((s) => s.id))).toEqual(new Set(labelsById.keys()));
  });
});

// ---------- per-invoice checks ----------

describe.each(INVOICE_SPECS.map((s) => [s.id, s] as const))("invoice %s", (id, spec) => {
  it("renders byte-identically to the committed PDF", async () => {
    const r = await render(spec);
    const committed = readFileSync(`${FIXTURE_DIR}${id}.pdf`);
    expect(Buffer.from(r.pdf).equals(committed)).toBe(true);
  });

  it("has a labels.json entry that deep-equals the renderer's label", async () => {
    const r = await render(spec);
    expect(labelsById.get(id)).toEqual(r.label);
  });

  it("extracted PDF text contains every printed field", async () => {
    const r = await render(spec);
    const text = norm(await extractText(r.pdf));
    expect(text).toContain(norm(r.printed.payeeName));
    expect(text).toContain(norm(r.printed.accountNumber));
    expect(text).toContain(norm(r.printed.amount));
    expect(text).toContain(norm(r.printed.dueDate));
    if (r.printed.reference !== null) expect(text).toContain(norm(r.printed.reference));
  });

  it("the printed account number parses back to the labelled IBAN", async () => {
    const r = await render(spec);
    const label = labelsById.get(id)!;
    expect(normalizeIban(r.printed.accountNumber)).toBe(label.accountNumber);
    expect(isValidIban(label.accountNumber)).toBe(true);
  });

  it("the printed amount parses back to the labelled minor units", async () => {
    const r = await render(spec);
    expect(parseAmountMinor(r.printed.amount)).toBe(labelsById.get(id)!.amountMinor);
  });

  it("the printed due date parses back to the labelled ISO date", async () => {
    const r = await render(spec);
    expect(parseDate(r.printed.dueDate)).toBe(labelsById.get(id)!.dueDate);
  });
});

describe("date and amount parsers (test-local)", () => {
  it.each([
    ["2026-10-31", "2026-10-31"],
    ["31.10.2026", "2026-10-31"],
    ["31/10/2026", "2026-10-31"],
    ["2026.11.01.", "2026-11-01"],
    ["31 October 2026", "2026-10-31"],
    ["October 31, 2026", "2026-10-31"],
    ["2026. november 12.", "2026-11-12"],
    ["1. Dezember 2026", "2026-12-01"],
    ["15 décembre 2026", "2026-12-15"],
    ["1er décembre 2026", "2026-12-01"],
  ])("parseDate(%s) -> %s", (printed, iso) => {
    expect(parseDate(printed)).toBe(iso);
  });

  it.each([
    ["EUR 2,400.00", 240_000],
    ["€2,400.00", 240_000],
    ["1.487,50 EUR", 148_750],
    ["180 000 Ft", 18_000_000],
    ["$1,162.50", 116_250],
  ])("parseAmountMinor(%s) -> %d", (printed, minor) => {
    expect(parseAmountMinor(printed)).toBe(minor);
  });
});

// ---------- supplier price lists and swapped invoice ----------

describe("supplier price lists", () => {
  it("supplier B's PDF carries the hidden instruction in its text layer", async () => {
    const text = norm(await extractText(await renderPriceList(SUPPLIERS.b)));
    expect(text).toContain("invoice #8812");
    expect(text).toContain("DE94 7603 0080 0981 1244 07");
  });

  it("supplier A's PDF does not carry that instruction", async () => {
    const text = norm(await extractText(await renderPriceList(SUPPLIERS.a)));
    expect(text).not.toContain("8812");
  });
});

describe("swapped tuition invoice", () => {
  it("keeps name, amount and reference but changes the beneficiary account", async () => {
    const normal = (await render(PAYEE_INVOICES["university"]!)).label;
    const swapped = (await render(PAYEE_INVOICES["university-swapped"]!)).label;
    expect(swapped.accountNumber).not.toBe(normal.accountNumber);
    expect(swapped.payeeName).toBe(normal.payeeName);
    expect(swapped.amountMinor).toBe(normal.amountMinor);
    expect(swapped.reference).toBe(normal.reference);
  });
});
