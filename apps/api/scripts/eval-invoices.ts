#!/usr/bin/env bun
/*
 * `bun run eval:invoices` (spec §19): runs the LIVE Reader (READER_MODEL) on the 30 labelled invoices in
 * fixtures/invoices/ and reports the exact-match rate per field, how many wrong values the evidence check
 * still verified, and latency. Writes docs/evidence/invoice-eval.json. Needs the reader model's key;
 * there is no replay fallback here, because the point is to measure the model.
 *   READER_MODEL=openrouter:… OPENROUTER_API_KEY=… bun run eval:invoices [--limit 5]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getReaderModel, readerSpec } from "../src/modules/ai/models.ts";
import { scoreInvoice, summarize, type InvoiceLabel, type InvoiceOutcome } from "../src/modules/reader/eval.ts";
import { readUntrusted } from "../src/modules/reader/reader.ts";

const root = new URL("../../../", import.meta.url);
const invoicesDir = new URL("fixtures/invoices/", root);
const { invoices } = JSON.parse(readFileSync(new URL("labels.json", invoicesDir), "utf8")) as { invoices: InvoiceLabel[] };

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : invoices.length;
const model = readerSpec().id;
getReaderModel(); // fail fast (AI_PROVIDER_KEY_MISSING) before reading anything

// The invoices are billed to the demo user (modules/demo/seed.ts, display name "Dana"); she reads them, so her own
// name is never accepted as the payee, as in readDocument for a signed-in user.
const ACCOUNT_HOLDER_NAMES = ["Dana"];

const results: InvoiceOutcome[] = [];
for (const label of invoices.slice(0, limit)) {
  const data = new Uint8Array(readFileSync(new URL(label.file, invoicesDir)));
  const t0 = performance.now();
  try {
    const result = await readUntrusted("invoice", { type: "pdf", data }, { accountHolderNames: ACCOUNT_HOLDER_NAMES });
    results.push(scoreInvoice(label, result, Math.round(performance.now() - t0)));
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    results.push(scoreInvoice(label, null, Math.round(performance.now() - t0), typeof code === "string" ? code : "READ_FAILED"));
  }
  const last = results.at(-1)!;
  const misses = Object.entries(last.fields).filter(([, f]) => !f.match).map(([k]) => k).join(", ");
  console.log(`${label.id} ${last.error ? `failed: ${last.error}` : last.exact ? "exact" : `miss: ${misses}`} (${last.ms} ms)`);
}

if (results.every((r) => r.error)) {
  console.error("every read failed; docs/evidence/invoice-eval.json left unchanged");
  process.exit(1);
}
const report = { ...summarize(model, results), generatedAt: new Date().toISOString() };
const dir = fileURLToPath(new URL("docs/evidence/", root));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}invoice-eval.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${model}: ${report.exactInvoices}/${report.invoices} invoices exact, median ${report.medianMs} ms`);
for (const [f, s] of Object.entries(report.perField)) console.log(`  ${f.padEnd(14)} ${s.matched}/${s.total}  wrong but verified: ${report.wrongButVerified[f as keyof typeof report.wrongButVerified]}`);
process.exit(results.some((r) => r.error) ? 1 : 0);
