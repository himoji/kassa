import type { ImportFile, ImportItems, ImportMapping, ImportPreviewResponse, ImportTransaction } from "@kassa/shared";
import type { LanguageModel } from "ai";

import { categorize, loadMerchantDictionary } from "../capture/categorize.ts";
import { normalizeMerchant } from "../capture/normalize.ts";
import { aiCategories, aiStatementRows } from "./ai.ts";
import { classifyRows, kindCategory, SPENDING_KINDS } from "./classify.ts";
import { decodeText, FileFormatError, parseCsv, readOfx, readPdf, readXlsx, sniffFormat, type FileFormat } from "./files.ts";
import { gridRecords, joinContinuation, type GridRecords } from "./grid.ts";
import { buildHistory } from "./history.ts";
import { lineRows } from "./lines.ts";
import { historyLines } from "./notes.ts";
import { cardKindFor, ImportFormatError, mapJson, mapRecordArrays, type MappedRecords, type RecordArray } from "./mapper.ts";
import { redactStatement, statementRedactor } from "./redact.ts";
import { statementFacts, type StatementFacts, type StatementRow } from "./statement.ts";

/*
 * POST /import/file and /import/preview (IMPORT_PLAN): bytes → format (files.ts) → rows (records, grids, PDF tables,
 * text lines, or the AI reader as a fallback) → kinds (classify.ts) → categories → history and suggestions
 * (history.ts) → the preview the user reviews before anything is written. Several files are read together so a
 * transfer between two of the user's banks is recognised once, from both sides.
 */

export interface ImportFileInput {
  name: string;
  data: Uint8Array;
}

export interface PreviewOptions {
  homeCurrency: string;
  /** The profile's display name (own transfers, redaction). */
  profileName?: string | null;
  /** auto: the AI reader only when the deterministic readers find too little; off: never; always: replace them. */
  ai?: "auto" | "off" | "always";
  /** The user's AI consent (and, region CN, the PIPL consent): without it no model sees anything. */
  aiAllowed: boolean;
  /** Injected model (tests, evaluation). */
  model?: LanguageModel;
  today: string;
  /** The user's remembered category for a merchant (capture memory). */
  rememberedCategory?: (merchantNorm: string) => Promise<string | null>;
  /** Called with exactly the text handed to a model (tests check it for leaks). */
  onModelText?: (text: string) => void;
}

/** Fewer rows than this from a PDF or text file means the layout was not understood. */
const MIN_DETERMINISTIC_ROWS = 3;
const CAPTION = /(?:транзакции|операции)\s*по\s*сч[её]ту[^\n]*?\b([A-Z]{3})\b|(?:transactions\s*(?:on|for)\s*account|account\s*transactions\s*:)[^\n]*?\b([A-Z]{3})\b/giu;

interface FileRead {
  file: ImportFile;
  mapped: MappedRecords;
  facts: StatementFacts;
  missed: number;
}

const emptyMapped = (): MappedRecords => ({ rows: [], bills: [], cards: [], budgets: [], mappings: [], warnings: [] });

function gridArrays(grids: { name: string; rows: (string | number)[][] }[]): { arrays: GridRecords[]; preamble: string } {
  const arrays: GridRecords[] = [];
  for (const g of grids) {
    const rec = gridRecords(g.rows, g.name);
    if (rec) arrays.push(rec);
  }
  return { arrays, preamble: arrays.map((a) => a.preamble).join("\n") };
}

/** PDF tables → record arrays, each with the account currency of its section (captions map to the last tables of a page). */
function pdfTableArrays(pdf: Awaited<ReturnType<typeof readPdf>>, fallbackCurrency: string | null): RecordArray[] {
  const out: RecordArray[] = [];
  let carry: string[] | null = null;
  let currency = fallbackCurrency;
  for (const page of pdf.pages) {
    const captions = [...page.text.matchAll(CAPTION)].map((m) => m[1] ?? m[2]!);
    const tables = pdf.tables.filter((t) => t.page === page.num);
    const recs = tables.map((t, i) => ({ rec: gridRecords(t.rows, `page ${page.num} table ${i + 1}`, carry), i })).filter((x) => x.rec);
    const withHeader = recs.filter((x) => x.rec!.rows.length > 0);
    for (const x of recs) joinContinuation(out.at(-1), x.rec!);
    withHeader.forEach((x, k) => {
      const captionIndex = k - (withHeader.length - captions.length);
      if (captionIndex >= 0 && captions[captionIndex]) currency = captions[captionIndex]!;
      out.push({ path: x.rec!.path, rows: x.rec!.rows, accountCurrency: currency });
      carry = x.rec!.header;
    });
  }
  return out;
}

async function readOne(input: ImportFileInput, index: number, o: PreviewOptions): Promise<FileRead | { own: ImportPreviewResponse }> {
  const sniffed = sniffFormat(input.data);
  if (typeof sniffed !== "string") throw new ImportFormatError(sniffed.unsupported);
  let format: FileFormat = sniffed;
  // Statement text with commas in it can look delimited; without a header row it is read as statement text.
  if (format === "csv" && !gridArrays([{ name: input.name, rows: parseCsv(decodeText(input.data)) }]).arrays.length) format = "text";
  const file: ImportFile = { name: input.name.slice(0, 200), format, via: "none", bank: null, accountCurrency: null, cardLast4: null, rows: 0, from: null, to: null, rejected: 0 };
  let mapped = emptyMapped();
  let facts: StatementFacts = { accountCurrency: null, cardLast4: null, holderNames: [], bank: null, period: null };
  let missed = 0;
  let text = "";

  if (format === "json") {
    const j = mapJson(decodeText(input.data), o.homeCurrency, index);
    if (j.own) return { own: j.own };
    mapped = j.mapped!;
    file.via = "records";
  } else if (format === "csv" || format === "xlsx") {
    const grids = format === "csv" ? [{ name: input.name, rows: parseCsv((text = decodeText(input.data))) }] : readXlsx(input.data);
    if (format === "xlsx") text = grids.map((g) => g.rows.map((r) => r.join(" ")).join("\n")).join("\n");
    const { arrays, preamble } = gridArrays(grids);
    facts = statementFacts(preamble || text);
    mapped = mapRecordArrays(arrays.map((a) => ({ ...a, accountCurrency: facts.accountCurrency })), { homeCurrency: o.homeCurrency, file: index, via: "records" });
    file.via = "records";
  } else if (format === "ofx") {
    const ofx = readOfx((text = decodeText(input.data)));
    mapped = mapRecordArrays([{ path: "$.STMTTRN", rows: ofx.records, accountCurrency: ofx.currency }], { homeCurrency: o.homeCurrency, docCurrency: ofx.currency, file: index, via: "records" });
    const fromText = statementFacts(text);
    facts = { ...fromText, accountCurrency: ofx.currency, period: ofx.period ?? fromText.period };
    file.via = "records";
  } else {
    let tables: RecordArray[] = [];
    if (format === "pdf") {
      const pdf = await readPdf(input.data);
      text = pdf.text;
      facts = statementFacts(text);
      tables = pdfTableArrays(pdf, facts.accountCurrency);
    } else {
      text = decodeText(input.data);
      facts = statementFacts(text);
    }
    const fromTables = tables.length ? mapRecordArrays(tables, { homeCurrency: o.homeCurrency, file: index, via: "table" }) : emptyMapped();
    const lines = lineRows(text, { accountCurrency: facts.accountCurrency, homeCurrency: o.homeCurrency, file: index });
    missed = lines.missed;
    if (fromTables.rows.length >= Math.max(MIN_DETERMINISTIC_ROWS, lines.rows.length * 0.8)) {
      mapped = fromTables;
      file.via = "table";
    } else {
      mapped = { ...emptyMapped(), rows: lines.rows };
      file.via = "lines";
    }
  }

  // The AI reader: only with consent, only on redacted text, only when the layout was not understood (or asked for).
  const wantAi = o.ai === "always" || (o.ai !== "off" && mapped.rows.length < MIN_DETERMINISTIC_ROWS && (format === "pdf" || format === "text"));
  if (wantAi && text.trim()) {
    if (!o.aiAllowed) mapped.warnings.push(`${file.name}: Kassa could not follow this layout, and reading it with AI needs your AI consent (Settings → Privacy).`);
    else {
      const redactor = statementRedactor([...facts.holderNames, ...(o.profileName ? [o.profileName] : [])]);
      const redacted = redactStatement(text, redactor);
      o.onModelText?.(redacted);
      const ai = await aiStatementRows(redacted, { accountCurrency: facts.accountCurrency, homeCurrency: o.homeCurrency, file: index, ...(o.model ? { model: o.model } : {}) });
      if (ai.rows.length > mapped.rows.length || o.ai === "always") {
        mapped = { ...mapped, rows: ai.rows };
        file.via = "ai";
      }
      file.rejected = ai.rejected;
      if (ai.rejected) mapped.warnings.push(`${file.name}: ${ai.rejected} rows the AI reported were not found in the statement and were left out.`);
    }
  }

  const days = mapped.rows.map((r) => r.occurredAt.slice(0, 10)).sort();
  // The statement's own period when its header states it (a quiet first week is still covered), else its rows' span.
  const period = facts.period && days.length && facts.period.from <= days[0]! && facts.period.to >= days.at(-1)! ? facts.period : null;
  Object.assign(file, { bank: facts.bank, accountCurrency: facts.accountCurrency ?? mostCommonCurrency(mapped.rows), cardLast4: facts.cardLast4, rows: mapped.rows.length, from: period?.from ?? days[0] ?? null, to: period?.to ?? days.at(-1) ?? null });
  if (facts.cardLast4) for (const r of mapped.rows) r.cardLast4 ??= facts.cardLast4;
  return { file, mapped, facts, missed };
}

function mostCommonCurrency(rows: StatementRow[]): string | null {
  const n = new Map<string, number>();
  for (const r of rows) {
    const c = r.settled?.currency ?? r.currency;
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Read the files and build the preview (see the header comment). */
export async function previewImport(inputs: ImportFileInput[], o: PreviewOptions): Promise<ImportPreviewResponse> {
  const reads: FileRead[] = [];
  const warnings: string[] = [];
  for (const [i, input] of inputs.entries()) {
    try {
      const r = await readOne(input, i, o);
      if ("own" in r) {
        if (inputs.length === 1) return r.own;
        warnings.push(`${input.name}: a Kassa export is imported on its own; upload it separately.`);
        continue;
      }
      reads.push(r);
    } catch (e) {
      if (!(e instanceof ImportFormatError || e instanceof FileFormatError) || inputs.length === 1) throw e instanceof FileFormatError ? new ImportFormatError(e.message) : e;
      warnings.push(`${input.name}: ${e.message}`);
    }
  }
  const rows = reads.flatMap((r) => r.mapped.rows);
  const mappings: ImportMapping[] = reads.flatMap((r) => r.mapped.mappings);
  const fileBills = reads.flatMap((r) => r.mapped.bills);
  const fileCards = reads.flatMap((r) => r.mapped.cards);
  const fileBudgets = reads.flatMap((r) => r.mapped.budgets);
  for (const r of reads) for (const w of r.mapped.warnings) warnings.push(reads.length > 1 && !w.startsWith(r.file.name) ? `${r.file.name}: ${w}` : w);
  if (rows.length === 0 && fileBills.length === 0 && fileCards.length === 0 && fileBudgets.length === 0) {
    const missed = reads.reduce((n, r) => n + r.missed, 0);
    throw new ImportFormatError(
      missed > 0
        ? `Kassa found ${missed} dated lines but could not read their amounts. Try the bank's CSV or Excel export, or allow AI reading.`
        : "No spending, bills, cards or budgets found in this file. It needs records with fields like amount, currency, date and description.",
    );
  }

  classifyRows(rows, { holders: reads.map((r) => [...r.facts.holderNames, ...(o.profileName ? [o.profileName] : [])]) });

  // Categories: the file's own, the row's kind, the user's memory, the dictionary, then one batched AI call.
  const dict = loadMerchantDictionary();
  const categoryOf = new Map<StatementRow, string>();
  const unknown = new Map<string, StatementRow[]>();
  for (const r of rows) {
    if (!r.kind || !SPENDING_KINDS.has(r.kind)) continue;
    const byKind = kindCategory(r.kind);
    if (r.category || byKind) {
      categoryOf.set(r, r.category ?? byKind!);
      continue;
    }
    const merchantNorm = normalizeMerchant(r.description) || "unknown";
    const remembered = o.rememberedCategory ? await o.rememberedCategory(merchantNorm) : null;
    const c = await categorize({ merchantNorm, merchantRaw: r.description, mcc: r.mcc, userCategory: remembered }, dict);
    categoryOf.set(r, c.category);
    if (c.category === "other") unknown.set(r.description, [...(unknown.get(r.description) ?? []), r]);
  }
  if (unknown.size && o.aiAllowed && o.ai !== "off") {
    const names = [...unknown.keys()];
    const redactor = statementRedactor([...reads.flatMap((r) => r.facts.holderNames), ...(o.profileName ? [o.profileName] : [])]);
    const redacted = names.map((n) => redactStatement(n, redactor));
    o.onModelText?.(redacted.join("\n"));
    const got = await aiCategories(redacted, dict.categories, o.model ? { model: o.model } : {});
    names.forEach((n, i) => {
      const c = got.get(redacted[i]!);
      if (c) for (const r of unknown.get(n)!) categoryOf.set(r, c);
    });
  }

  const transactions: ImportTransaction[] = rows
    .filter((r) => r.kind && SPENDING_KINDS.has(r.kind))
    .slice(-5000)
    .map((r) => ({
      occurredAt: r.occurredAt,
      merchant: r.description.slice(0, 140) || "Unknown merchant",
      amountMinor: Math.abs(r.amountMinor),
      currency: r.currency,
      category: categoryOf.get(r) ?? null,
      cardLast4: r.cardLast4,
      mcc: r.mcc,
      settledAmountMinor: r.settled ? Math.abs(r.settled.amountMinor) : null,
      settledCurrency: r.settled?.currency ?? null,
    }));

  const statements = reads.flatMap((r, i) => (r.file.from && r.file.to ? [{ file: reads[i]!.mapped.rows[0]?.file ?? i, name: r.file.name, bank: r.file.bank, from: r.file.from, to: r.file.to }] : []));
  const { history, suggestions } = await buildHistory(rows, { homeCurrency: o.homeCurrency, today: o.today, categoryOf: (r) => categoryOf.get(r) ?? "other", statements });

  // Cards: the files' own lists, plus each statement's card (last 4 digits only).
  const cards: ImportItems["cards"] = [...fileCards];
  for (const r of reads) {
    const last4 = r.facts.cardLast4;
    if (!last4 || cards.some((c) => c.last4 === last4)) continue;
    const billing = r.file.accountCurrency ?? o.homeCurrency;
    cards.push({ label: `${r.facts.bank ?? "Card"} •••• ${last4}`.slice(0, 60), last4, billingCurrency: billing, kind: cardKindFor(billing, o.homeCurrency) });
  }

  const own = history.counts.ownTransfers;
  if (own) warnings.push(`${own} transfers between your own accounts were left out, so the same money is not counted twice.`);
  if (history.counts.refunds) warnings.push(`${history.counts.refunds} refunds, cancelled holds and card holds mirrored in a second currency were left out of spending.`);
  if (history.counts.incoming) warnings.push(`${history.counts.incoming} incoming payments were read as income, not spending.`);

  return {
    source: "mapped",
    items: {
      transactions,
      bills: [...fileBills, ...suggestions.bills.filter((b) => !fileBills.some((f) => f.payeeName === b.payeeName))].slice(0, 200),
      cards: cards.slice(0, 50),
      budgets: (fileBudgets.length ? fileBudgets : suggestions.budgets).slice(0, 20),
      incomes: suggestions.incomes,
    },
    mappings,
    warnings,
    files: reads.map((r) => r.file),
    history: rows.length ? { ...history, notes: historyLines(history) } : null,
  };
}

/** Pasted text: JSON, CSV or a statement's text, read like a file. */
export function previewText(text: string, o: PreviewOptions): Promise<ImportPreviewResponse> {
  const trimmed = text.trimStart();
  const name = trimmed.startsWith("{") || trimmed.startsWith("[") ? "pasted.json" : "pasted.txt";
  return previewImport([{ name, data: new TextEncoder().encode(text) }], o);
}
