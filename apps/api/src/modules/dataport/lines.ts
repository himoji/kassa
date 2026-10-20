import { parseAmount, parseDate } from "./mapper.ts";
import { currencyOfLabel, type StatementRow } from "./statement.ts";

/*
 * Statements without ruled tables (Kaspi's PDF, most US bank PDFs, plain-text exports): one transaction per line that
 * starts with a date. The amount is the first money token after the date (a number with two decimals, or one carrying
 * a currency sign or code). Following lines refine the row: "(- 4 000,00 HUF)" is the amount in the shop's currency,
 * a short text line continues the description ("Бағамдық айырма"). Section headings ("Withdrawals and other
 * subtractions", "Списания") give the sign when the amounts carry none.
 */

const LEADING_DATE = /^\s*(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?(?:\s+(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)?(?=\s|$)/;
const MONEY =
  /(?<![\w.,/-])([+\-−–]\s?)?(US\$|[$€₸£¥])?\s?(\d{1,3}(?:[ \u00a0\u202f.,']\d{3})+(?:[.,]\d{2})?|\d+[.,]\d{2})(?![\d/])\s?(₸|€|\$|Ft|тг|[A-Z]{3}(?![A-Za-z]))?/gu;
const FOREIGN = /^\(\s*([+\-−–])?\s*(\d[\d\s\u00a0.,']*\d)\s*([A-Z]{3}|₸|€|\$|Ft)\s*\)$/u;
const SECTION_IN = /^(?:deposits?|credits?|additions|incoming|money in|поступления|зачисления|приход|кіріс|jóváírások|الإيداعات|إيداعات|دائن|זיכויים|הפקדות|alacak|gutschriften|crédits|abonos)(?![\p{L}])/iu;
const SECTION_OUT = /^(?:service fees|fees|withdrawals?|subtractions|debits?|purchases|payments|checks|card (?:transactions|subtractions)|atm and debit|money out|списания|расход|расходы|шығыс|terhelések|السحوبات|مدين|חיובים|משיכות|borç|belastungen|débits|cargos)(?![\p{L}])/iu;
/** A date at the end of a line: right-to-left statements (Arabic, Hebrew, Persian) put it there in reading order. */
const TRAILING_DATE = /\s(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*$/;
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const FOOTER = /^--\s*\d+\s*of\s*\d+\s*--$|www\.|^page\s*\d+|\bстр\.\s*\d|continued on|^\d+\s*\/\s*\d+$|^-\s*\d+\s*-$/i;
const SUMMARY = /^(?:total|subtotal|ending balance|beginning balance|итого|всего|остаток|барлығы|жиыны|қолжетімді)(?![\p{L}])/iu;
const CODE_LINE = /^(?:Код\s*авторизации|Авторизация\s*коды|Auth(?:ori[sz]ation)?\s*code|Reference|Ref\.?\s*#)/i;

export interface LineRowsResult {
  rows: StatementRow[];
  /** Date-led lines that had no amount (a layout the parser did not understand). */
  missed: number;
}

/** Statement rows from text lines (see the header comment). */
export function lineRows(text: string, o: { accountCurrency: string | null; homeCurrency: string; file: number }): LineRowsResult {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t+/g, "  ").trimEnd());
  const dayFirst = dayFirstOf(lines);
  const rows: StatementRow[] = [];
  let missed = 0;
  let section: "in" | "out" | null = null;
  let last = null as { row: StatementRow; extra: number } | null;
  // A dated line without an amount: the amount may follow within 3 lines (US "service fees" rows wrap).
  let pending: { lead: string; text: string; lines: number } | null = null;

  const emit = (dateText: string, rest: string): boolean => {
    MONEY.lastIndex = 0;
    const m = MONEY.exec(rest);
    if (!m) return false;
    const [token, signRaw, pre, num, post] = m;
    const currency = currencyOfLabel(post ?? pre ?? "") ?? o.accountCurrency ?? o.homeCurrency;
    const abs = parseAmount(num!, currency, false);
    const when = parseDate(dateText, dayFirst);
    if (!abs || !when) return false;
    // A sign written after the number ("120.50-", "5000.00+"): right-to-left statements and some European exports.
    const trailing = /^\s?([+\-−–])(?![\d])/.exec(rest.slice(m.index + token.length));
    const after = rest.slice(m.index + token.length + (trailing ? trailing[0].length : 0));
    const description = (rest.slice(0, m.index) + " " + after).replace(/\s{2,}/g, " ").trim();
    const signText = signRaw ?? trailing?.[1];
    const explicit = signText ? (/[+]/.test(signText) ? 1 : -1) : /^\(.*\)$/.test(token.trim()) ? -1 : 0;
    const sign = explicit || (section === "in" ? 1 : section === "out" ? -1 : 0) || -1;
    const row: StatementRow = {
      occurredAt: when.toISOString(),
      description: description || "Unknown merchant",
      operation: null,
      amountMinor: sign * Math.abs(abs),
      currency,
      settled: null,
      category: null,
      cardLast4: null,
      mcc: null,
      via: "lines",
      file: o.file,
    };
    rows.push(row);
    last = { row, extra: 0 };
    return true;
  };

  for (const raw of lines) {
    let line = raw.trim();
    // Right-to-left rows read date-last; move the date to the front so they parse like any other row.
    if (RTL.test(line) && !LEADING_DATE.test(line)) {
      const tail = TRAILING_DATE.exec(line);
      if (tail) line = `${tail[0].trim()} ${line.slice(0, tail.index).trim()}`;
    }
    if (!line) {
      last = null;
      continue;
    }
    const lead = LEADING_DATE.exec(line);
    if (!lead && pending) {
      if (FOOTER.test(line) || SUMMARY.test(line)) {
        missed++;
        pending = null;
        continue;
      }
      pending.text += ` ${line}`;
      pending.lines++;
      MONEY.lastIndex = 0;
      if (MONEY.test(line)) {
        if (!emit(pending.lead, pending.text)) missed++;
        pending = null;
      } else if (pending.lines >= 3) {
        missed++;
        pending = null;
      }
      continue;
    }
    if (lead && pending) {
      missed++;
      pending = null;
    }
    if (!lead) {
      if (FOOTER.test(line)) continue;
      if (line.length < 80 && SECTION_IN.test(line)) section = "in";
      else if (line.length < 80 && SECTION_OUT.test(line)) section = "out";
      if (!last) continue;
      const foreign = FOREIGN.exec(line);
      if (foreign && !last.row.settled) {
        const cur = currencyOfLabel(foreign[3]!);
        const amt = cur ? parseAmount(foreign[2]!, cur, false) : null;
        if (cur && amt && cur !== last.row.currency) {
          // The line's amount is what the account paid; this one is the price in the shop's currency.
          const sign = Math.sign(last.row.amountMinor) || -1;
          last.row.settled = { amountMinor: last.row.amountMinor, currency: last.row.currency };
          last.row.amountMinor = sign * Math.abs(amt);
          last.row.currency = cur;
        }
        continue;
      }
      MONEY.lastIndex = 0;
      if (CODE_LINE.test(line) || SUMMARY.test(line) || MONEY.test(line) || line.length > 60 || last.extra >= 2) {
        last = null;
        continue;
      }
      last.row.description = `${last.row.description} ${line}`.slice(0, 140);
      last.extra++;
      continue;
    }

    const rest = line.slice(lead[0].length);
    last = null;
    if (!emit(lead[1]!, rest)) pending = { lead: lead[1]!, text: rest, lines: 0 };
  }
  if (pending) missed++;
  return { rows, missed };
}

/** Day-first unless a leading date proves month-first (04/14/26). */
function dayFirstOf(lines: string[]): boolean {
  for (const l of lines) {
    const m = /^\s*(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}/.exec(l);
    if (!m) continue;
    if (Number(m[1]) > 12) return true;
    if (Number(m[2]) > 12) return false;
  }
  return true;
}
