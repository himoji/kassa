// Writes fixtures/invoices/inv-XX.pdf and labels.json from fixtures/invoices/source.ts.
// Deterministic: re-running produces byte-identical files (checked by test/invoices.test.ts).
// Usage: bun run fixtures:invoices   (from apps/mock-world)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { INVOICE_SPECS } from "../../../fixtures/invoices/source.ts";
import { renderInvoice } from "../src/pdf/invoice.ts";

const outDir = fileURLToPath(new URL("../../../fixtures/invoices/", import.meta.url));
const labels = [];
for (const spec of INVOICE_SPECS) {
  const { pdf, label } = await renderInvoice(spec);
  writeFileSync(`${outDir}${label.file}`, pdf);
  labels.push(label);
}
const doc = {
  _note:
    "Ground truth for the Reader accuracy eval (spec §19 eval:invoices). Generated from source.ts by apps/mock-world/scripts/generate-invoices.ts; do not edit by hand. accountNumber is the electronic IBAN (ISO 13616, no spaces); amount is the amount DUE as a major-unit decimal string, amountMinor the same in ISO 4217 minor units; dueDate is ISO 8601. reference is null when the invoice asks for none. All parties and accounts are fictitious.",
  version: 1,
  invoices: labels,
};
writeFileSync(`${outDir}labels.json`, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${labels.length} invoices + labels.json to ${outDir}`);
