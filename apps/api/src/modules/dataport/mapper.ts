import { currencyExponent, isKnownCurrency, KassaExport, OnboardingObligationDraft, PayeeKind, toMinor, type ImportItems, type ImportMapping, type ImportPreviewResponse } from "@kassa/shared";
import * as chrono from "chrono-node";
import { distance } from "fastest-levenshtein";

import { parseAmountString, SYMBOLS } from "../capture/amount.ts";
import type { RowVia, StatementRow } from "./statement.ts";

/*
 * Import mapping. Kassa's own export (`kassa-export` v1) is read as it is. Records from anywhere else (JSON arrays, CSV
 * and Excel rows, PDF tables: see read.ts) are mapped deterministically, nothing is sent to a model:
 *  1. find the arrays of records anywhere in the document (nested objects are flattened: amount.value),
 *  2. match each record field to a Kassa field by name: multilingual synonyms (en, de, ru/kk, hu, zh, fr, es), the
 *     head word of a multi-word header ("Валюта операции" is a currency, "Debit amount" a debit), then a fuzzy match
 *     (Levenshtein, fastest-levenshtein) for misspellings and variants,
 *  3. decide what the array holds (spending, bills, cards or budgets) from the fields it has,
 *  4. parse each value: amounts in any locale style (capture/amount.ts), currency codes or symbols, dates as ISO,
 *     epoch, or written dates (chrono-node), with the day/month order read from the whole column.
 * Spending arrays become statement rows (statement.ts) with their sign: money in is kept, classify.ts decides what it
 * is (income, a refund, a transfer between the user's own accounts). Bank tables with separate in / out columns
 * ("Приход" / "Расход", "Paid in" / "Paid out") and a purchase amount next to the account amount ("Сумма" in HUF,
 * "Расход в валюте счета" in KZT) keep both: the second is what the card really charged (the fee x-ray reads it).
 * Rows that cannot be read are skipped and counted; the preview says why.
 */

export type Field =
  | "amount"
  | "amountMinor"
  | "accountAmount"
  | "credit"
  | "debit"
  | "currency"
  | "date"
  | "merchant"
  | "operation"
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
  amount: ["amount", "sum", "value", "total", "price", "cost", "money", "transactionamount", "betrag", "summe", "сумма", "summa", "сома", "сомасы", "összeg", "osszeg", "金额", "金額", "montant", "importe", "kwota", "tutar", "charge", "spent"],
  amountMinor: ["amountminor", "amountcents", "cents", "minor", "amountinminor", "minorunits"],
  accountAmount: ["accountamount", "billingamount", "settledamount", "amountinaccountcurrency", "billedamount", "postedamount"],
  credit: ["credit", "credits", "deposit", "deposits", "paidin", "moneyin", "incoming", "income", "приход", "поступление", "поступления", "зачисление", "зачисления", "кредит", "кіріс", "haben", "gutschrift", "jóváírás", "收入", "存入"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "paidout", "moneyout", "outgoing", "expense", "expenses", "расход", "списание", "списания", "дебет", "шығыс", "soll", "lastschrift", "terhelés", "支出", "支取"],
  currency: ["currency", "ccy", "cur", "curr", "currencycode", "iso", "waehrung", "währung", "валюта", "valuta", "pénznem", "penznem", "币种", "货币", "devise", "moneda", "waluta"],
  date: ["date", "time", "datetime", "timestamp", "occurredat", "occurred", "bookingdate", "bookedat", "valuedate", "transactiondate", "txdate", "createdat", "created", "posted", "postedat", "paidat", "buchungsdatum", "datum", "дата", "күні", "күн", "dátum", "datum", "日期", "时间", "fecha", "data"],
  merchant: ["merchant", "description", "payee", "payeename", "counterparty", "counterpartyname", "recipient", "beneficiary", "title", "memo", "details", "narrative", "name", "shop", "store", "vendor", "place", "partner", "empfaenger", "empfänger", "verwendungszweck", "получатель", "описание", "назначение", "детали", "толығырақ", "сипаттама", "kedvezményezett", "megnevezés", "közlemény", "商户", "商家", "描述", "commerçant", "comercio", "concepto"],
  operation: ["operation", "operationtype", "transactiontype", "операция", "операции", "типоперации", "вид", "операция түрі", "tranzakciótípus", "交易类型"],
  category: ["category", "categoryname", "kategorie", "категория", "санат", "kategória", "kategoria", "类别", "分类", "catégorie", "categoria", "tag", "group"],
  card: ["card", "cardlast4", "cardnumber", "pan", "maskedpan", "karte", "карта", "kártya", "卡号"],
  mcc: ["mcc", "merchantcategorycode"],
  direction: ["direction", "type", "kind", "debitcredit", "creditdebit", "drcr", "sign", "тип", "típus"],
  due: ["duedate", "due", "nextdue", "nextduedate", "nextpayment", "nextpaymentdate", "billingdate", "payday", "fälligkeit", "срок", "határidő"],
  recurrence: ["recurrence", "frequency", "interval", "period", "cycle", "repeat", "schedule", "periodicity", "rhythmus", "периодичность"],
  label: ["label", "cardname", "bank", "issuer", "nickname", "product"],
  last4: ["last4", "lastfour", "last4digits", "cardlast4", "lastdigits", "mask"],
  limit: ["limit", "budget", "cap", "max", "maximum", "monthlylimit", "monthlybudget", "planned", "allowance", "лимит", "keret"],
  payeeKind: ["payeekind", "billtype", "billkind"],
};

const norm = (k: string) => k.toLowerCase().normalize("NFKC").replace(/[\s_\-.:/()[\]]+/g, "");
const exact = (k: string): Field | null => {
  for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) if (names.some((n) => norm(n) === k)) return field;
  return null;
};

/** "…in account currency" / "в валюте счета": an amount on the account side, not the purchase side. */
const ACCOUNT_SIDE = /валютесч[её]та|счетавалюте|шотвалютасында|accountcurrency|inaccount|billingcurrency|settled|posted/;

/** The Kassa field a source field name stands for, or null: exact synonym, a word of it, a synonym inside it, else fuzzy. */
export function fieldFor(key: string): Field | null {
  const leaf = norm(key.split(".").at(-1) ?? key);
  const full = norm(key);
  for (const k of [full, leaf]) {
    const f = exact(k);
    if (f) return accountSide(f, full);
  }
  // Multi-word headers: "Дата совершения операции", "Валюта операции", "Debit Amount", "Приход в валюте счета".
  const words = (key.split(".").at(-1) ?? key).split(/[\s_\-/()[\]:,]+/).map(norm).filter(Boolean);
  if (words.length > 1) {
    const hits = words.map(exact).filter((f): f is Field => !!f);
    if (hits.length) {
      // In/out columns win over a generic amount; else the head word: first in Cyrillic (Russian/Kazakh put the head
      // noun first: "Валюта операции"), last in Latin scripts ("Transaction Date").
      const inOut = hits.find((f) => f === "credit" || f === "debit");
      const head = inOut ?? (/[Ѐ-ӿ]/.test(key) ? hits[0]! : hits.at(-1)!);
      return accountSide(head, full);
    }
  }
  // "transaction_amount_eur", "booking_date_utc": a synonym of 4+ letters inside the name (longest wins).
  let best: { field: Field; len: number } | null = null;
  for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) {
    for (const n of names.map(norm)) if (n.length >= 4 && leaf.includes(n) && (!best || n.length > best.len)) best = { field, len: n.length };
  }
  if (best) return accountSide(best.field, full);
  for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) {
    if (names.some((n) => norm(n).length >= 5 && distance(norm(n), leaf) <= 1)) return field;
  }
  return null;
}

/** An "amount" header that says it is in the account's currency is the account-side amount. */
function accountSide(f: Field, full: string): Field {
  return f === "amount" && ACCOUNT_SIDE.test(full) ? "accountAmount" : f;
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
export function recordArrays(doc: unknown): RecordArray[] {
  const out: RecordArray[] = [];
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

export interface RecordArray {
  path: string;
  rows: Row[];
  /** The account currency, when the text around the records says it (statement.ts). */
  accountCurrency?: string | null;
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
  return map;
}

type Kind = ImportMapping["kind"];

function kindOf(cols: Map<Field, string>): Kind | null {
  const has = (f: Field) => cols.has(f);
  const amount = has("amount") || has("amountMinor") || has("debit") || has("credit") || has("accountAmount");
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
  const t = s.trim();
  const negative = /^[-−–(]/.test(t) || /-\s*$/.test(t) || /^\(.*\)$/.test(t) || /^[^\d]{0,4}[-−–]\s*\d/.test(t);
  // A line break inside a cell is a wrapped number ("2\n288.88" is 2 288.88).
  const digits = t.replace(/[^\d.,\s\u00a0\u202f']/g, "").replace(/\s+/g, " ").trim();
  if (!digits) return null;
  try {
    const minor = minorColumn ? Number(digits.replace(/\D/g, "")) : parseAmountString(digits, currency);
    return negative ? -minor : minor;
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

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

/** A date (time kept when the value has one, else noon UTC so the day survives any time zone). */
export function parseDate(v: unknown, dayFirst: boolean): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial day numbers (1900 system) for spreadsheet cells, epoch seconds or milliseconds otherwise.
    if (v > 20_000 && v < 80_000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86_400_000));
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
  // 15.10.2026, 15.10.26, 04/14/26, "13.10.2026\n17:44:44": parsed exactly (chrono reads two-digit years oddly).
  const m = NUMERIC_DATE.exec(s.replace(/\s+/g, " "));
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [day, month] = dayFirst ? [a, b] : [b, a];
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = m[4] ? new Date(Date.UTC(year, month - 1, day, Number(m[4]), Number(m[5]), Number(m[6] ?? 0))) : new Date(Date.UTC(year, month - 1, day, 12));
    return d.getUTCDate() === day ? d : null;
  }
  return (dayFirst ? chrono.en.GB : chrono.en).parseDate(s) ?? null;
}

const OUTGOING = /debit|expense|outgoing|\bout\b|payment|purchase|withdrawal|spend|charge|списание|расход|покупка|оплата|перевод|аударым|сатып|шығыс|terhelés|vásárlás|支出|dr\b/i;
const INCOMING = /credit|income|incoming|\bin\b|deposit|refund|salary|topup|top-up|зачисление|приход|пополнение|поступление|возврат|толықтыру|түскені|кіріс|jóváírás|收入|cr\b/i;

function recurrenceOf(v: unknown): "MONTHLY" | "ONCE" | "TERM" {
  const s = (text(v) ?? "").toLowerCase();
  if (/once|one[- ]?time|single|разов/.test(s)) return "ONCE";
  if (/term|semester|quarter|year|annual|ежегод|семестр/.test(s)) return "TERM";
  return "MONTHLY";
}

export function payeeKindOf(v: unknown, name: string, category: string | null): PayeeKind {
  const s = `${text(v) ?? ""} ${name} ${category ?? ""}`.toLowerCase();
  if (/rent|landlord|dorm|housing|apartment|аренд|квартир|жалд|albérlet/.test(s)) return "LANDLORD";
  if (/tuition|university|college|school|универ|egyetem/.test(s)) return "UNIVERSITY";
  if (/insur|страхов|сақтандыр|biztosít/.test(s)) return "INSURER";
  const k = (text(v) ?? "").toUpperCase();
  return (PayeeKind.options as readonly string[]).includes(k) ? (k as PayeeKind) : "MERCHANT";
}

export const CATEGORY_ID = (s: string) =>
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
  return { transactions: [], bills: [], cards: [], budgets: [], incomes: [] };
}

export interface MappedRecords {
  rows: StatementRow[];
  bills: ImportItems["bills"];
  cards: ImportItems["cards"];
  budgets: ImportItems["budgets"];
  mappings: ImportMapping[];
  warnings: string[];
}

/**
 * The account currency of a table with an account-side column: the currency of the rows whose purchase amount equals
 * the account amount (a fee in KZT on a KZT account: "200 KZT … 200").
 */
function inferAccountCurrency(rows: Row[], get: (r: Row, f: Field) => unknown, rowCurrency: (r: Row) => string): string | null {
  const votes = new Map<string, number>();
  for (const r of rows.slice(0, 500)) {
    const c = rowCurrency(r);
    const a = parseAmount(get(r, "amount"), c, false);
    const side = [get(r, "debit"), get(r, "credit"), get(r, "accountAmount")].map((v) => parseAmount(v, c, false)).find((x) => x);
    if (a && side && Math.abs(a) === Math.abs(side)) votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Map arrays of records (JSON, CSV/Excel rows, PDF tables) to statement rows, bills, cards and budgets. */
export function mapRecordArrays(arrays: RecordArray[], o: { homeCurrency: string; docCurrency?: string | null; file?: number; via?: RowVia }): MappedRecords {
  const out: MappedRecords = { rows: [], bills: [], cards: [], budgets: [], mappings: [], warnings: [] };
  let assumedCurrency = 0;
  let previousAccount: string | null = null;
  const totals = { amount: 0, date: 0, other: 0 };

  for (const { path, rows, accountCurrency } of arrays) {
    const cols = columns(rows);
    const kind = kindOf(cols);
    if (!kind) continue;
    const get = (r: Row, f: Field) => (cols.has(f) ? r[cols.get(f)!] : undefined);
    const dayFirst = dayFirstColumn(rows.map((r) => get(r, cols.has("date") ? "date" : "due")));
    let imported = 0;
    const skipped = { amount: 0, date: 0, other: 0 };
    const amountValues = rows.map((r) => get(r, "amountMinor") ?? get(r, "amount"));
    const signs = amountValues.map((v) => (typeof v === "number" ? Math.sign(v) : /^\s*[-−(]/.test(String(v ?? "")) ? -1 : 1));
    const mixedSigns = signs.includes(-1) && signs.includes(1);

    const currencyOf = (r: Row, fallback: string | null): string => {
      const c = text(get(r, "currency"))?.toUpperCase();
      if (c && isKnownCurrency(c)) return c;
      const inAmount = text(get(r, "amount")) ?? text(get(r, "debit")) ?? text(get(r, "credit"));
      const fromAmount = inAmount ? currencyIn(inAmount) : null;
      if (fromAmount) return fromAmount;
      if (fallback) return fallback;
      if (o.docCurrency) return o.docCurrency;
      assumedCurrency++;
      return o.homeCurrency;
    };
    const sideColumns = cols.has("debit") || cols.has("credit") || cols.has("accountAmount");
    // Account currency: the text says it, else the rows show it (a table continued from the previous page keeps it).
    const account: string | null =
      accountCurrency ??
      (sideColumns && cols.has("amount") && cols.has("currency") ? inferAccountCurrency(rows, get, (r) => currencyOf(r, null)) : null) ??
      (sideColumns && cols.has("amount") && cols.has("currency") ? previousAccount : null);
    if (account) previousAccount = account;

    for (const r of rows) {
      if (kind === "transactions") {
        // "- 5 519,45 ₸ (- 4 000,00 HUF)": the account amount with the shop's amount in brackets (Kaspi's layout).
        const cell = text(get(r, "amount"));
        const both = cell ? /^([\s\S]*?\d[\s\S]*?)\s*\(\s*([-−–+]?\s*\d[\d\s\u00a0.,']*)\s*([A-Z]{3}|₸|€|\$|Ft)\s*\)\s*$/u.exec(cell) : null;
        if (both) {
          const mainCurrency = currencyIn(both[1]!) ?? account ?? o.homeCurrency;
          const shopCurrency = currencyIn(both[3]!);
          const main = parseAmount(both[1]!, mainCurrency, false);
          const shop = shopCurrency ? parseAmount(both[2]!, shopCurrency, false) : null;
          const when = parseDate(get(r, "date"), dayFirst);
          if (main && shop && shopCurrency && when) {
            const sign = Math.sign(main);
            out.rows.push({
              occurredAt: when.toISOString(),
              description: cleanDescription(text(get(r, "merchant")) ?? text(get(r, "operation")) ?? "Unknown merchant"),
              operation: text(get(r, "operation")),
              amountMinor: sign * Math.abs(shop),
              currency: shopCurrency,
              settled: shopCurrency !== mainCurrency ? { amountMinor: main, currency: mainCurrency } : null,
              category: null,
              cardLast4: null,
              mcc: null,
              via: o.via ?? "records",
              file: o.file ?? 0,
            });
            imported++;
            continue;
          }
        }
        // Purchase side: amount + its currency. Account side: debit / credit / account amount in the account currency.
        const purchaseCurrency = currencyOf(r, sideColumns && cols.has("amount") ? null : account);
        const debit = parseAmount(get(r, "debit"), account ?? purchaseCurrency, false);
        const credit = parseAmount(get(r, "credit"), account ?? purchaseCurrency, false);
        const accountAmt = parseAmount(get(r, "accountAmount"), account ?? purchaseCurrency, false);
        const base = cols.has("amountMinor") ? parseAmount(get(r, "amountMinor"), purchaseCurrency, true) : parseAmount(get(r, "amount"), purchaseCurrency, false);
        const sideValue = debit ? -Math.abs(debit) : credit ? Math.abs(credit) : accountAmt;
        const primary = base ?? sideValue;
        if (!primary) {
          skipped.amount++;
          continue;
        }
        // Direction: an in/out column, else the direction or operation words, else the sign when the column has both.
        const dirText = `${text(get(r, "direction")) ?? ""} ${text(get(r, "operation")) ?? ""}`.trim();
        let out_: boolean;
        if (debit || credit) out_ = !!debit && !credit;
        else if (dirText && (INCOMING.test(dirText) || OUTGOING.test(dirText))) out_ = !(INCOMING.test(dirText) && !OUTGOING.test(dirText));
        else if (mixedSigns || primary < 0) out_ = primary < 0;
        else out_ = true;
        const sign = out_ ? -1 : 1;
        const when = parseDate(get(r, "date"), dayFirst);
        if (!when) {
          skipped.date++;
          continue;
        }
        const usesSide = base === null || base === undefined;
        const amountCurrency = usesSide ? (account ?? purchaseCurrency) : purchaseCurrency;
        const sideAbs = Math.abs(sideValue ?? 0);
        const settled =
          !usesSide && sideAbs && account && account !== amountCurrency ? { amountMinor: sign * sideAbs, currency: account } : null;
        const card = (text(get(r, "card")) ?? "").replace(/\D/g, "").slice(-4);
        const mcc = (text(get(r, "mcc")) ?? "").replace(/\D/g, "");
        const description = cleanDescription(text(get(r, "merchant")) ?? text(get(r, "operation")) ?? "Unknown merchant");
        out.rows.push({
          occurredAt: when.toISOString(),
          description,
          operation: text(get(r, "operation")),
          amountMinor: sign * Math.abs(primary),
          currency: amountCurrency,
          settled,
          category: text(get(r, "category")) ? CATEGORY_ID(text(get(r, "category"))!) || null : null,
          cardLast4: card.length === 4 ? card : null,
          mcc: mcc.length === 4 ? mcc : null,
          via: o.via ?? "records",
          file: o.file ?? 0,
        });
        imported++;
      } else if (kind === "bills") {
        const currency = currencyOf(r, null);
        const amount = cols.has("amountMinor") ? parseAmount(get(r, "amountMinor"), currency, true) : parseAmount(get(r, "amount"), currency, false);
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
        out.bills.push(bill.data);
        imported++;
      } else if (kind === "cards") {
        const digits = (text(get(r, "last4")) ?? text(get(r, "card")) ?? "").replace(/\D/g, "").slice(-4);
        if (digits.length !== 4) {
          skipped.other++;
          continue;
        }
        const c = text(get(r, "currency"))?.toUpperCase();
        const billingCurrency = c && isKnownCurrency(c) ? c : o.homeCurrency;
        const label = (text(get(r, "label")) ?? text(get(r, "merchant")) ?? `Card ${digits}`).slice(0, 60);
        out.cards.push({ label, last4: digits, billingCurrency, kind: cardKindFor(billingCurrency, o.homeCurrency) });
        imported++;
      } else {
        const category = CATEGORY_ID(text(get(r, "category")) ?? "");
        const limit = parseAmount(get(r, "limit"), o.homeCurrency, false);
        if (!category || !limit || limit <= 0) {
          skipped.other++;
          continue;
        }
        out.budgets.push({ category, limitHomeMinor: limit });
        imported++;
      }
    }

    out.mappings.push({ path, kind, fields: Object.fromEntries([...cols].map(([f, k]) => [f, k])), rows: rows.length, imported });
    totals.amount += skipped.amount;
    totals.date += skipped.date;
    totals.other += skipped.other;
  }
  // One line per reason for the whole file (a 77-page statement must not give 77 warnings).
  if (totals.amount) out.warnings.push(`${totals.amount} rows had no readable amount and were skipped.`);
  if (totals.date) out.warnings.push(`${totals.date} rows had no readable date and were skipped.`);
  if (totals.other) out.warnings.push(`${totals.other} rows were incomplete and were skipped.`);

  if (assumedCurrency) out.warnings.push(`${assumedCurrency} rows had no currency; ${o.homeCurrency} (your home currency) was assumed.`);
  return out;
}

export function cardKindFor(billingCurrency: string, homeCurrency: string): ImportItems["cards"][number]["kind"] {
  return billingCurrency === homeCurrency ? "HOME_KZT" : billingCurrency === "USD" ? "USD" : billingCurrency === "HUF" ? "LOCAL_HUF" : "MULTI";
}

/**
 * A description as the user should see it: authorisation codes, reference numbers and confirmation codes cut
 * ("Код авторизации: 870643", "Conf# jb4knpz4y", "74908366103667036779390"), whitespace folded, 140 characters.
 */
export function cleanDescription(s: string): string {
  return (
    s
      .replace(/(?:Код\s*авторизации|Авторизация\s*коды|Референс|Reference|Auth(?:ori[sz]ation)?\s*code|Conf(?:irmation)?\s*#?|Ref(?:erence)?\s*#|Trace\s*#)\s*[:#]?\s*[\w-]+/giu, " ")
      // Id labels whose number was cut ("БИН , внешний"), and Kazakh payment purpose codes ("КНП=119").
      .replace(/(?<![\p{L}])(?:БИН|ИИН|ЖСН|BIN|IIN|КНП\s*=\s*\d+)(?![\p{L}])\s*[;:]?\s*(?:\d{12})?\s*[,;]?\s*(?:внешний|external)?/giu, " ")
      // Account numbers never ride along in a merchant name (IBAN shape, ISO 13616).
      .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[account]")
      .replace(/\b\d{12,}\b/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[\s,;]+$/, "")
      .trim()
      .slice(0, 140) || "Unknown merchant"
  );
}

/** Parse JSON text: Kassa's own export as it is, any other JSON through mapRecordArrays (see the header comment). */
export function mapJson(textIn: string, homeCurrency: string, file = 0): { own: ImportPreviewResponse | null; mapped: MappedRecords | null } {
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
      own: {
        source: "kassa",
        items: { transactions: e.transactions, bills: e.bills, cards: e.cards, budgets: e.budgets.map(({ category, limitHomeMinor }) => ({ category, limitHomeMinor })), incomes: e.profile.incomes },
        mappings: [],
        warnings: e.profile.homeCurrency !== homeCurrency ? [`This export was made with home currency ${e.profile.homeCurrency}; yours is ${homeCurrency}. Budgets are in ${e.profile.homeCurrency} amounts.`] : [],
        files: [],
        history: null,
      },
      mapped: null,
    };
  }
  if (doc && typeof doc === "object" && (doc as Row).format === "kassa-export") {
    throw new ImportFormatError(`This Kassa export is damaged or from a newer version: ${own.error.issues[0]?.message ?? "invalid"}`);
  }
  return { own: null, mapped: mapRecordArrays(recordArrays(doc), { homeCurrency, docCurrency: documentCurrency(doc), file, via: "records" }) };
}
