/* eval:invoices scoring (spec §19 "Invoice accuracy"): per-field match, verified-but-wrong, summary. */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { scoreInvoice, summarize, type InvoiceLabel } from "../../src/modules/reader/eval.ts";
import { readUntrusted } from "../../src/modules/reader/reader.ts";

const IBAN = "HU83118009905400221700000005";
const label: InvoiceLabel = {
  id: "inv-x",
  file: "inv-x.pdf",
  layout: "classic",
  language: "en",
  payeeName: "University in Budapest",
  accountNumber: IBAN,
  reference: "RF39RUB2026F04217",
  amount: "2400.00",
  amountMinor: 240000,
  currency: "EUR",
  dueDate: "2026-10-31",
};
const SOURCE = `University in Budapest
IBAN: HU83 1180 0990 5400 2217 0000 0005
Reference: RF39 RUB2 026F 0421 7
Amount due: EUR 2,400.00
Due date: 2026-10-31`;

const f = (value: string | null, evidence: string | null) => ({ value, evidence });
const good = {
  payeeName: f("University in Budapest", "University in Budapest"),
  accountNumber: f(IBAN, "HU83 1180 0990 5400 2217 0000 0005"),
  reference: f("RF39RUB2026F04217", "RF39 RUB2 026F 0421 7"),
  amount: f("2400.00", "EUR 2,400.00"),
  currency: f("EUR", "EUR 2,400.00"),
  dueDate: f("2026-10-31", "Due date: 2026-10-31"),
};

function mockModel(output: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    }),
  });
}

describe("eval:invoices scoring", () => {
  it("a faithful read is exact; spaced account and reference still match", async () => {
    const r = await readUntrusted("invoice", { type: "text", text: SOURCE }, { model: mockModel(good) });
    const o = scoreInvoice(label, r, 12);
    expect(o.exact).toBe(true);
    expect(o.fields.amount).toEqual({ expected: "2400.00", got: "2400.00", match: true, verified: true });
  });

  it("a wrong amount is a miss, and the evidence check does not verify it", async () => {
    const r = await readUntrusted("invoice", { type: "text", text: SOURCE }, { model: mockModel({ ...good, amount: f("4200.00", "EUR 2,400.00") }) });
    const o = scoreInvoice(label, r, 12);
    expect(o.exact).toBe(false);
    expect(o.fields.amount.match).toBe(false);
    expect(o.fields.amount.verified).toBe(false);
  });

  it("a failed read counts every field as a miss; the summary counts rates and wrong-but-verified", async () => {
    const r = await readUntrusted("invoice", { type: "text", text: SOURCE }, { model: mockModel(good) });
    const report = summarize("test:model", [scoreInvoice(label, r, 10), scoreInvoice(label, null, 30, "AI_PROVIDER_UNAVAILABLE")]);
    expect(report.exactInvoices).toBe(1);
    expect(report.perField.amount).toEqual({ matched: 1, verified: 1, total: 2, exactMatchRate: 0.5 });
    expect(report.wrongButVerified.amount).toBe(0);
    expect(report.results[1]!.error).toBe("AI_PROVIDER_UNAVAILABLE");
  });
});
