import { currencyExponent, isKnownCurrency, KassaExport, OnboardingObligationDraft, PayeeKind, toMinor, type ImportItems, type ImportMapping, type ImportPreviewResponse } from "@kassa/shared";
import * as chrono from "chrono-node";
import { distance } from "fastest-levenshtein";

import { parseAmountString, SYMBOLS } from "../capture/amount.ts";

/*
 * Import mapping (POST /import/preview). Kassa's own export (`kassa-export` v1) is read as it is. Any other JSON is
 * mapped deterministically, nothing is sent to a model:
 *  1. find the arrays of records anywhere in the document (nested objects are flattened: amount.value),
 *  2. match each record field to a Kassa field by name: multilingual synonyms (en, de, ru/kk, hu, zh, fr, es),
 *     then a fuzzy match (Levenshtein, fastest-levenshtein) for misspellings and variants,
 *  3. decide what the array holds (spending, bills, cards or budgets) from the fields it has,
 *  4. parse each value: amounts in any locale style (capture/amount.ts), currency codes or symbols, dates as ISO,
 *     epoch, or written dates (chrono-node), with the day/month order read from the whole column.
 * Rows that cannot be read are skipped and counted; the preview says why.
 */

export type Field =
  | "amount"
  | "amountMinor"
  | "currency"
  | "date"
  | "merchant"
  | "category"
  | "card"
  | "mcc"
  | "direction"
  | "due"
  | "recurrence"
  | "label"
  | "last4"
  | "limit"
  | "payeeKind";

const SYNONYMS: Record<Field, string[]> = {
  amount: ["amount", "sum", "value", "total", "price", "cost", "money", "transactionamount", "betrag", "summe", "сумма", "summa", "сома", "összeg", "osszeg", "金额", "金額", "montant", "importe", "kwota", "tutar", "debit", "charge", "spent"],
  amountMinor: ["amountminor", "amountcents", "cents", "minor", "amountinminor", "minorunits"],
  currency: ["currency", "ccy", "cur", "curr", "currencycode", "iso", "waehrung", "währung", "валюта", "valuta", "pénznem", "penznem", "币种", "货币", "devise", "moneda", "waluta"],
  date: ["date", "time", "datetime", "timestamp", "occurredat", "occurred", "bookingdate", "bookedat", "valuedate", "transactiondate", "txdate", "createdat", "created", "posted", "postedat", "paidat", "buchungsdatum", "datum", "дата", "күні", "dátum", "datum", "日期", "时间", "fecha", "data"],
  merchant: ["merchant", "description", "payee", "payeename", "counterparty", "counterpartyname", "recipient", "beneficiary", "title", "memo", "details", "narrative", "name", "shop", "store", "vendor", "place", "partner", "empfaenger", "empfänger", "verwendungszweck", "получатель", "описание", "назначение", "kedvezményezett", "megnevezés", "商户", "商家", "描述", "commerçant", "comercio", "concepto"],
  category: ["category", "categoryname", "kategorie", "категория", "санат", "kategória", "kategoria", "类别", "分类", "catégorie", "categoria", "tag", "group"],
  card: ["card", "cardlast4", "cardnumber", "pan", "maskedpan", "karte", "карта", "kártya", "卡号"],
  mcc: ["mcc", "merchantcategorycode"],
  direction: ["direction", "type", "kind", "debitcredit", "creditdebit", "drcr", "sign", "operation", "тип", "típus"],
  due: ["duedate", "due", "nextdue", "nextduedate", "nextpayment", "nextpaymentdate", "billingdate", "payday", "fälligkeit", "срок", "határidő"],
  recurrence: ["recurrence", "frequency", "interval", "period", "cycle", "repeat", "schedule", "periodicity", "rhythmus", "периодичность"],
  label: ["label", "cardname", "bank", "issuer", "nickname", "product"],
  last4: ["last4", "lastfour", "last4digits", "cardlast4", "lastdigits", "mask"],
  limit: ["limit", "budget", "cap", "max", "maximum", "monthlylimit", "monthlybudget", "planned", "allowance", "лимит", "keret"],
  payeeKind: ["payeekind", "billtype", "billkind"],
};

const norm = (k: string) => k.toLowerCase().normalize("NFKC").replace(/[\s_\-.:/()[\]]+/g, "");

/** The Kassa field a source field name stands for, or null: exact synonym, a synonym inside it, else fuzzy. */
export function fieldFor(key: string): Field | null {
  const leaf = norm(key.split(".").at(-1) ?? key);
  const full = norm(key);
  for (const k of [full, leaf]) {
    for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) if (names.some((n) => norm(n) === k)) return field;
  }
  // "transaction_amount_eur", "booking_date_utc": a synonym of 4+ letters inside the name (longest wins).
  let best: { field: Field; len: number } | null = null;
  for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) {
    for (const n of names.map(norm)) if (n.length >= 4 && leaf.includes(n) && (!best || n.length > best.len)) best = { field, len: n.length };
  }
  if (best) return best.field;
  for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) {
    if (names.some((n) => norm(n).length >= 5 && distance(norm(n), leaf) <= 1)) return field;
  }
  return null;
}

type Row = Record<string, unknown>;

/** `{a: {b: 1}}` → `{"a.b": 1}` (one record; arrays inside a record stay as they are). */
function flatten(o: Row, prefix = "", out: Row = {}, depth = 0): Row {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) flatten(v as Row, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

/** Arrays of records anywhere in the document (depth ≤ 5), with their JSON path. */
export function recordArrays(doc: unknown): { path: string; rows: Row[] }[] {
  const out: { path: string; rows: Row[] }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 5 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const objs = v.filter((x): x is Row => !!x && typeof x === "object" && !Array.isArray(x));
      if (objs.length > 0 && objs.length >= v.length * 0.6) {
        out.push({ path, rows: objs.map((r) => flatten(r)) });
        return;
      }
      v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v as Row)) walk(x, `${path}.${k}`, depth + 1);
  };
  walk(doc, "$", 0);
  return out;
}

/** Top-level hints a document may carry for all its records ("currency": "EUR"). */
function documentCurrency(doc: unknown): string | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  for (const [k, v] of Object.entries(doc as Row)) {
    if (fieldFor(k) === "currency" && typeof v === "string" && isKnownCurrency(v.trim().toUpperCase())) return v.trim().toUpperCase();
  }
  return null;
}

function columns(rows: Row[]): Map<Field, string> {
  const counts = new Map<string, number>();
  for (const r of rows.slice(0, 200)) for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined && v !== "") counts.set(k, (counts.get(k) ?? 0) + 1);
  const map = new Map<Field, string>();
  // Most frequent keys first, so a sparse "name" never wins over a full "description".
  for (const [key] of [...counts].sort((a, b) => b[1] - a[1])) {
    const f = fieldFor(key);
    if (f && !map.has(f)) map.set(f, key);
  }
  // "amount" + "amount_minor" both present: the minor-unit column is exact.
  return map;
}

type Kind = ImportMapping["kind"];

function kindOf(cols: Map<Field, string>): Kind | null {
  const has = (f: Field) => cols.has(f);
  const amount = has("amount") || has("amountMinor");
  if ((has("last4") || has("card")) && !amount) return "cards";
  if (has("limit") && has("category") && !has("date")) return "budgets";
  if (amount && (has("due") || has("recurrence"))) return "bills";
  if (amount && (has("date") || has("merchant"))) return "transactions";
  return null;
}

// ---------- values ----------

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function currencyIn(s: string): string | null {
  const code = /\b([A-Z]{3})\b/.exec(s.toUpperCase())?.[1];
  if (code && isKnownCurrency(code)) return code;
  for (const [re, c] of SYMBOLS) if (re.test(s)) return c;
  return null;
}

/** Signed amount in minor units, or null. Numbers are major units unless the column is a minor-unit one. */
export function parseAmount(v: unknown, currency: string, minorColumn: boolean): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (minorColumn) return Number.isSafeInteger(v) ? v : null;
    try {
      return toMinor(Math.abs(v).toFixed(10).replace(/\.?0+$/, ""), currency) * Math.sign(v);
    } catch {
      // More fraction digits than the currency has (a computed float): round to its minor unit.
      return Math.round(v * 10 ** currencyExponent(currency)) || null;
    }
  }
  const s = text(v);
  if (!s) return null;
  const negative = /^[-−–(]|-\s*$|^\s*-/.test(s.trim()) || /^\(.*\)$/.test(s.trim());
  const digits = s.replace(/[^\d.,\s\u00a0\u202f']/g, "").trim();
  if (!digits) return null;
  try {
    const minor = minorColumn ? Number(digits.replace(/\D/g, "")) : parseAmountString(digits, currency);
    return negative ? -minor : minor;
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Day-first unless the column shows otherwise ("10/31/2026" anywhere → month-first). */
export function dayFirstColumn(values: unknown[]): boolean {
  for (const v of values) {
    const m = typeof v === "string" ? /^(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}/.exec(v.trim()) : null;
    if (!m) continue;
    if (Number(m[1]) > 12) return true;
    if (Number(m[2]) > 12) return false;
  }
  return true;
}

export function parseDate(v: unknown, dayFirst: boolean): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Epoch seconds or milliseconds (anything after 2001 in ms is > 1e12).
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = text(v);
  if (!s) return null;
  if (ISO_DATE.test(s)) {
    const d = new Date(s.length === 10 ? `${s}T12:00:00Z` : s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return (dayFirst ? chrono.en.GB : chrono.en).parseDate(s) ?? null;
}

const OUTGOING = /debit|expense|outgoing|out|payment|purchase|withdrawal|spend|charge|списание|расход|terhelés|支出|dr\b/i;
const INCOMING = /credit|income|incoming|\bin\b|deposit|refund|salary|topup|top-up|зачисление|приход|jóváírás|收入|cr\b/i;

function recurrenceOf(v: unknown): "MONTHLY" | "ONCE" | "TERM" {
  const s = (text(v) ?? "").toLowerCase();
  if (/once|one[- ]?time|single|разов/.test(s)) return "ONCE";
  if (/term|semester|quarter|year|annual|ежегод|семестр/.test(s)) return "TERM";
  return "MONTHLY";
}

function payeeKindOf(v: unknown, name: string, category: string | null): PayeeKind {
  const s = `${text(v) ?? ""} ${name} ${category ?? ""}`.toLowerCase();
  if (/rent|landlord|dorm|housing|apartment|аренд|квартир|albérlet/.test(s)) return "LANDLORD";
  if (/tuition|university|college|school|универ|egyetem/.test(s)) return "UNIVERSITY";
  if (/insur|страхов|biztosít/.test(s)) return "INSURER";
  const k = (text(v) ?? "").toUpperCase();
  return (PayeeKind.options as readonly string[]).includes(k) ? (k as PayeeKind) : "MERCHANT";
}

const CATEGORY_ID = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ---------- mapping ----------

export class ImportFormatError extends Error {}

export function emptyItems(): ImportItems {
  return { transactions: [], bills: [], cards: [], budgets: [] };
}

/** Parse the file's text and map it (see the header comment). */
export function mapImport(textIn: string, homeCurrency: string): ImportPreviewResponse {
  let doc: unknown;
  try {
    doc = JSON.parse(textIn.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new ImportFormatError(`This is not valid JSON: ${(e as Error).message}`);
  }

  const own = KassaExport.safeParse(doc);
  if (own.success) {
    const e = own.data;
    return {
      source: "kassa",
      items: { transactions: e.transactions, bills: e.bills, cards: e.cards, budgets: e.budgets.map(({ category, limitHomeMinor }) => ({ category, limitHomeMinor })) },
      mappings: [],
      warnings: e.profile.homeCurrency !== homeCurrency ? [`This export was made with home currency ${e.profile.homeCurrency}; yours is ${homeCurrency}. Budgets are in ${e.profile.homeCurrency} amounts.`] : [],
    };
  }
  if (doc && typeof doc === "object" && (doc as Row).format === "kassa-export") {
    throw new ImportFormatError(`This Kassa export is damaged or from a newer version: ${own.error.issues[0]?.message ?? "invalid"}`);
  }

  const items = emptyItems();
  const mappings: ImportMapping[] = [];
  const warnings: string[] = [];
  const docCurrency = documentCurrency(doc);
  let assumedCurrency = 0;

  for (const { path, rows } of recordArrays(doc)) {
    const cols = columns(rows);
    const kind = kindOf(cols);
    if (!kind) continue;
    const get = (r: Row, f: Field) => (cols.has(f) ? r[cols.get(f)!] : undefined);
    const dayFirst = dayFirstColumn(rows.map((r) => get(r, cols.has("date") ? "date" : "due")));
    let imported = 0;
    const skipped = { amount: 0, date: 0, incoming: 0, other: 0 };
    const amountValues = rows.map((r) => get(r, "amountMinor") ?? get(r, "amount"));
    const signs = amountValues.map((v) => (typeof v === "number" ? Math.sign(v) : /^\s*[-−(]/.test(String(v ?? "")) ? -1 : 1));
    const mixedSigns = signs.includes(-1) && signs.includes(1);

    const currencyOf = (r: Row): string => {
      const c = text(get(r, "currency"))?.toUpperCase();
      if (c && isKnownCurrency(c)) return c;
      const inAmount = text(get(r, "amount"));
      const fromAmount = inAmount ? currencyIn(inAmount) : null;
      if (fromAmount) return fromAmount;
      if (docCurrency) return docCurrency;
      assumedCurrency++;
      return homeCurrency;
    };
    const amountOf = (r: Row, currency: string) =>
      cols.has("amountMinor") ? parseAmount(get(r, "amountMinor"), currency, true) : parseAmount(get(r, "amount"), currency, false);

    for (const r of rows) {
      if (kind === "transactions") {
        const currency = currencyOf(r);
        const signed = amountOf(r, currency);
        if (!signed) {
          skipped.amount++;
          continue;
        }
        const dir = text(get(r, "direction")) ?? "";
        const incoming = dir ? INCOMING.test(dir) && !OUTGOING.test(dir) : mixedSigns && signed > 0;
        if (incoming) {
          skipped.incoming++;
          continue;
        }
        const when = parseDate(get(r, "date"), dayFirst);
        if (!when) {
          skipped.date++;
          continue;
        }
        const card = (text(get(r, "card")) ?? "").replace(/\D/g, "").slice(-4);
        const mcc = (text(get(r, "mcc")) ?? "").replace(/\D/g, "");
        items.transactions.push({
          occurredAt: when.toISOString(),
          merchant: (text(get(r, "merchant")) ?? "Unknown merchant").slice(0, 140),
          amountMinor: Math.abs(signed),
          currency,
          category: text(get(r, "category")) ? CATEGORY_ID(text(get(r, "category"))!) || null : null,
          cardLast4: card.length === 4 ? card : null,
          mcc: mcc.length === 4 ? mcc : null,
        });
        imported++;
      } else if (kind === "bills") {
        const currency = currencyOf(r);
        const amount = amountOf(r, currency);
        const due = parseDate(get(r, "due") ?? get(r, "date"), dayFirst);
        const name = text(get(r, "merchant")) ?? text(get(r, "label"));
        if (!amount || !due || !name) {
          if (!amount) skipped.amount++;
          else if (!due) skipped.date++;
          else skipped.other++;
          continue;
        }
        const category = text(get(r, "category"));
        const bill = OnboardingObligationDraft.safeParse({
          payeeName: name.slice(0, 140),
          payeeKind: payeeKindOf(get(r, "payeeKind"), name, category),
          amountMinor: Math.abs(amount),
          currency,
          dueDate: isoDay(due),
          recurrence: recurrenceOf(get(r, "recurrence")),
          category: category ? CATEGORY_ID(category) || "bills" : "bills",
        });
        if (!bill.success) {
          skipped.other++;
          continue;
        }
        items.bills.push(bill.data);
        imported++;
      } else if (kind === "cards") {
        const digits = (text(get(r, "last4")) ?? text(get(r, "card")) ?? "").replace(/\D/g, "").slice(-4);
        if (digits.length !== 4) {
          skipped.other++;
          continue;
        }
        const c = text(get(r, "currency"))?.toUpperCase();
        const billingCurrency = c && isKnownCurrency(c) ? c : homeCurrency;
        const label = (text(get(r, "label")) ?? text(get(r, "merchant")) ?? `Card ${digits}`).slice(0, 60);
        items.cards.push({ label, last4: digits, billingCurrency, kind: billingCurrency === homeCurrency ? "HOME_KZT" : billingCurrency === "USD" ? "USD" : "MULTI" });
        imported++;
      } else {
        const category = CATEGORY_ID(text(get(r, "category")) ?? "");
        const limit = parseAmount(get(r, "limit"), homeCurrency, false);
        if (!category || !limit || limit <= 0) {
          skipped.other++;
          continue;
        }
        items.budgets.push({ category, limitHomeMinor: limit });
        imported++;
      }
    }

    mappings.push({ path, kind, fields: Object.fromEntries([...cols].map(([f, k]) => [f, k])), rows: rows.length, imported });
    const where = path === "$" ? "the file" : path;
    if (skipped.incoming) warnings.push(`${skipped.incoming} incoming payments in ${where} were left out (Kassa imports spending).`);
    if (skipped.amount) warnings.push(`${skipped.amount} rows in ${where} had no readable amount and were skipped.`);
    if (skipped.date) warnings.push(`${skipped.date} rows in ${where} had no readable date and were skipped.`);
    if (skipped.other) warnings.push(`${skipped.other} rows in ${where} were incomplete and were skipped.`);
  }

  if (assumedCurrency) warnings.push(`${assumedCurrency} rows had no currency; ${homeCurrency} (your home currency) was assumed.`);
  if (mappings.length === 0) throw new ImportFormatError("No spending, bills, cards or budgets found in this file. It needs records with fields like amount, currency, date and description.");
  // A budget per category once (the last one wins).
  items.budgets = [...new Map(items.budgets.map((b) => [b.category, b])).values()].slice(0, 20);
  return { source: "mapped", items, mappings, warnings };
}
