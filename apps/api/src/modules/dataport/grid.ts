import { fieldFor, type Field, type RecordArray } from "./mapper.ts";

/*
 * Grids (CSV and Excel rows, PDF table cells) → records keyed by the header row. Bank exports put a preamble above
 * the header (bank name, account, period); it is returned as text so statement.ts can read the account currency and
 * card from it. PDF tables repeat their header on every page and split a row across a page break ("09.10.2026" on one
 * page, "20:33:44" and the rest of the amount on the next): repeated headers are skipped and split rows are joined.
 */

type Cell = string | number;
const DATE_CELL = /^\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/;
const TIME_ONLY = /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/;
const AMOUNT_FIELDS: Field[] = ["amount", "amountMinor", "debit", "credit", "accountAmount"];

const cellText = (c: Cell | undefined) => (c === undefined ? "" : String(c).trim());

/** Index of the header row in the first rows: it names a date and an amount (or in/out) column. */
export function findHeader(grid: Cell[][], scan = 40): number {
  for (let i = 0; i < Math.min(grid.length, scan); i++) {
    const cells = grid[i]!.map(cellText).filter((c) => c && !/^\d/.test(c));
    if (cells.length < 2) continue;
    const fields = new Set(cells.map((c) => fieldFor(c)).filter(Boolean));
    if (fields.has("date") && AMOUNT_FIELDS.some((f) => fields.has(f))) return i;
    // Bills / budgets / cards sheets have no date column.
    if ((fields.has("limit") && fields.has("category")) || (fields.has("last4") && fields.has("label"))) return i;
    if (fields.has("due") && fields.has("amount")) return i;
  }
  return -1;
}

/** Unique header names ("Date", "Date" → "Date", "Date (2)"); empty headers are named by position. */
function headerNames(row: Cell[]): string[] {
  const seen = new Map<string, number>();
  return row.map((c, i) => {
    const base = cellText(c).replace(/\s+/g, " ") || `column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Join a split row's cells onto the row above: text with a space (amounts too: "1" + "793.36" is "1 793.36"). */
function joinRows(above: Cell[], below: Cell[]): Cell[] {
  const n = Math.max(above.length, below.length);
  return Array.from({ length: n }, (_, i) => [cellText(above[i]), cellText(below[i])].filter(Boolean).join(" "));
}

export interface GridRecords extends RecordArray {
  header: string[];
  /** Text above the header (statement facts). */
  preamble: string;
  /** The first row when it continues the previous table's last row (a row split by a page break). */
  continuation: Record<string, unknown> | null;
}

/** Join a table's continuation row onto the last record of the table before it (same header names). */
export function joinContinuation(previous: { rows: Record<string, unknown>[] } | undefined, rec: GridRecords): void {
  if (!previous || !rec.continuation || previous.rows.length === 0) return;
  const last = previous.rows[previous.rows.length - 1]!;
  for (const [k, v] of Object.entries(rec.continuation)) {
    const add = cellText(v as Cell);
    if (add) last[k] = [cellText(last[k] as Cell), add].filter(Boolean).join(" ");
  }
}

/**
 * Records from one grid. `carryHeader` continues a table from the previous page that has no header of its own (same
 * column count). Returns null when no header is found and none is carried.
 */
export function gridRecords(grid: Cell[][], path: string, carryHeader?: string[] | null): GridRecords | null {
  const h = findHeader(grid);
  let header: string[];
  let start: number;
  if (h >= 0) {
    header = headerNames(grid[h]!);
    start = h + 1;
  } else if (carryHeader && grid.some((r) => r.length === carryHeader.length)) {
    header = carryHeader;
    start = 0;
  } else return null;
  const preamble = grid.slice(0, Math.max(0, h)).map((r) => r.map(cellText).filter(Boolean).join(" ")).join("\n");
  const dateCol = header.findIndex((name) => fieldFor(name) === "date");
  const headerKey = header.join("|").toLowerCase().replace(/\s+/g, "");
  const rows: Cell[][] = [];
  let continuation: Cell[] | null = null;
  for (const raw of grid.slice(start)) {
    const row = raw.map((c) => (typeof c === "string" ? c.trim() : c));
    if (!row.some((c) => cellText(c))) continue;
    if (headerNames(row).join("|").toLowerCase().replace(/\s+/g, "") === headerKey) continue;
    const date = dateCol >= 0 ? cellText(row[dateCol]) : "";
    const prev = rows.at(-1);
    if (!prev && !continuation && dateCol >= 0 && TIME_ONLY.test(date)) {
      continuation = row;
      continue;
    }
    // A page-split row: its date cell holds only the time, or nothing while the row above has a date.
    if (prev && dateCol >= 0 && (TIME_ONLY.test(date) || (!date && DATE_CELL.test(cellText(prev[dateCol])) && !looksLikeTotal(row)))) {
      rows[rows.length - 1] = joinRows(prev, row);
      continue;
    }
    rows.push(row);
  }
  const records = rows.map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ""])));
  const toRecord = (r: Cell[]) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ""]));
  return { path, header, preamble, rows: records, continuation: continuation ? toRecord(continuation) : null };
}

/** "Итого", "Total", "Барлығы": a summary line, never part of a transaction. */
function looksLikeTotal(row: Cell[]): boolean {
  return row.some((c) => /^(итого|всего|total|subtotal|барлығы|жиыны|összesen|summe)\b/i.test(cellText(c)));
}
