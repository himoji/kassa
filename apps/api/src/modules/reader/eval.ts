import { toMinor } from "@kassa/shared";

import type { ReaderResult } from "./schemas.ts";

/*
 * Reader accuracy on the 30 labelled invoices (spec §19 "Invoice accuracy", fixtures/invoices/labels.json).
 * Per invoice and per field: is the value the Reader returned equal to the ground truth, and did the server's
 * evidence check verify it. Normalisation is deliberately small (case and spaces for names, accounts and
 * references; amounts compared in minor units) so a pass means the payment would carry the right value.
 */

export const INVOICE_FIELDS = ["payeeName", "accountNumber", "reference", "amount", "currency", "dueDate"] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];

export interface InvoiceLabel {
  id: string;
  file: string;
  layout: string;
  language: string;
  payeeName: string;
  accountNumber: string;
  reference: string | null;
  amount: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
}

export interface FieldOutcome {
  expected: string | null;
  got: string | null;
  match: boolean;
  verified: boolean;
}

export interface InvoiceOutcome {
  id: string;
  layout: string;
  language: string;
  ms: number;
  /** Error code when the read failed (provider down, schema error); every field then counts as a miss. */
  error?: string;
  fields: Record<InvoiceField, FieldOutcome>;
  reasonCodes: string[];
  /** All six fields match. */
  exact: boolean;
}

export interface FieldStats {
  matched: number;
  verified: number;
  total: number;
  exactMatchRate: number;
}

export interface InvoiceEvalReport {
  model: string;
  invoices: number;
  exactInvoices: number;
  perField: Record<InvoiceField, FieldStats>;
  /** Wrong values the server's evidence check still marked VERIFIED (should be 0 for amount and account). */
  wrongButVerified: Record<InvoiceField, number>;
  medianMs: number;
  results: InvoiceOutcome[];
}

const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();

function same(field: InvoiceField, expected: string | null, got: string | null, currency: string): boolean {
  if (expected === null || got === null) return expected === got;
  switch (field) {
    case "payeeName":
      return expected.trim().replace(/\s+/g, " ").toLowerCase() === got.trim().replace(/\s+/g, " ").toLowerCase();
    case "amount":
      try {
        return toMinor(expected, currency) === toMinor(got, currency);
      } catch {
        return false;
      }
    case "dueDate":
      return expected === got.trim();
    default:
      return squash(expected) === squash(got);
  }
}

/** Compare one Reader result (or a failed read) with its label. */
export function scoreInvoice(label: InvoiceLabel, result: ReaderResult | null, ms: number, error?: string): InvoiceOutcome {
  const fields = {} as Record<InvoiceField, FieldOutcome>;
  for (const f of INVOICE_FIELDS) {
    const expected = label[f];
    const field = result?.fields[f];
    const got = field?.value ?? null;
    fields[f] = { expected, got, match: !error && same(f, expected, got, label.currency), verified: field?.check === "VERIFIED" };
  }
  return {
    id: label.id,
    layout: label.layout,
    language: label.language,
    ms,
    ...(error ? { error } : {}),
    fields,
    reasonCodes: result?.reasonCodes ?? [],
    exact: INVOICE_FIELDS.every((f) => fields[f].match),
  };
}

export function summarize(model: string, results: InvoiceOutcome[]): InvoiceEvalReport {
  const perField = {} as Record<InvoiceField, FieldStats>;
  const wrongButVerified = {} as Record<InvoiceField, number>;
  for (const f of INVOICE_FIELDS) {
    const matched = results.filter((r) => r.fields[f].match).length;
    const verified = results.filter((r) => r.fields[f].verified).length;
    perField[f] = { matched, verified, total: results.length, exactMatchRate: results.length ? matched / results.length : 0 };
    wrongButVerified[f] = results.filter((r) => !r.fields[f].match && r.fields[f].verified).length;
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const medianMs = times.length ? times[Math.floor(times.length / 2)]! : 0;
  return { model, invoices: results.length, exactInvoices: results.filter((r) => r.exact).length, perField, wrongButVerified, medianMs, results };
}
