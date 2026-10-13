import { isKnownCurrency, toMinor, type FieldCheck } from "@kassa/shared";

import { isValidIban } from "../agent/redact.ts";

/*
 * Server-side checks of Reader output against the source (spec §9, I10):
 *  1. evidence is a substring of the extracted source text (exact; then after Unicode NFKC + whitespace
 *     collapse, since PDF text extraction is not whitespace-stable);
 *  2. the value is consistent with its evidence — numbers re-parsed from the evidence must equal the
 *     parsed value; accounts must appear in the evidence (and IBANs must pass ISO 7064 MOD 97-10).
 */

export function normalizeSpace(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function evidenceInSource(evidence: string, source: string): boolean {
  if (!evidence.trim()) return false;
  if (source.includes(evidence)) return true;
  return normalizeSpace(source).includes(normalizeSpace(evidence));
}

/**
 * All plausible decimal readings of the numeric tokens in `text`, as strings with "." decimal point.
 * Handles "2,400.00", "2.400,00", "2 400,00", "2'400.00", "2400". An ambiguous "2.400" yields both
 * "2.400" and "2400"; matching any reading is enough because the number must still literally be there.
 */
export function numberReadings(text: string): string[] {
  const out = new Set<string>();
  const whole = text.normalize("NFKC").match(/\d[\d .,'’\u00a0\u202f]*\d|\d/g) ?? [];
  // Each whole token plus its space-separated pieces ("31.10.2026 2,400.00" must not glue together).
  const tokens = new Set<string>();
  for (const w of whole) {
    tokens.add(w);
    for (const piece of w.split(/[ \u00a0\u202f]+/)) if (/\d/.test(piece)) tokens.add(piece.replace(/^[.,']+|[.,']+$/g, ""));
  }
  for (const raw of tokens) {
    const tok = raw.replace(/[\u00a0\u202f]/g, " ").replace(/’/g, "'");
    const compact = tok.replace(/[ ']/g, "");
    const lastDot = compact.lastIndexOf(".");
    const lastComma = compact.lastIndexOf(",");
    const candidates: string[] = [];
    if (lastDot === -1 && lastComma === -1) candidates.push(compact);
    else {
      const sepIdx = Math.max(lastDot, lastComma);
      const sep = compact[sepIdx]!;
      const other = sep === "." ? "," : ".";
      const fracLen = compact.length - sepIdx - 1;
      // Reading A: last separator is the decimal point.
      const intPart = compact.slice(0, sepIdx).split(other).join("").split(sep).join("");
      if (fracLen > 0) candidates.push(`${intPart}.${compact.slice(sepIdx + 1)}`);
      // Reading B: every separator is a thousands separator (groups of 3).
      if (/^\d{1,3}([.,]\d{3})+$/.test(compact)) candidates.push(compact.replace(/[.,]/g, ""));
    }
    // Also readings for space-grouped integers inside the token ("2 400,00" → handled above via compact).
    for (const c of candidates) if (/^\d+(\.\d+)?$/.test(c)) out.add(c);
  }
  return [...out];
}

/** Compare decimal strings numerically (exact, via minor units at max precision). */
function sameDecimal(a: string, b: string): boolean {
  const norm = (s: string) => {
    const [i = "0", f = ""] = s.split(".");
    return `${i.replace(/^0+(?=\d)/, "")}.${f.replace(/0+$/, "")}`;
  };
  return norm(a) === norm(b);
}

export function checkAmount(value: string, evidence: string, currency: string | null): { ok: boolean; amountMinor?: number; why?: string } {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return { ok: false, why: "amount is not a plain decimal" };
  if (!numberReadings(evidence).some((r) => sameDecimal(r, value.trim()))) return { ok: false, why: "number differs from evidence" };
  if (!currency || !isKnownCurrency(currency)) return { ok: true };
  try {
    return { ok: true, amountMinor: toMinor(value.trim(), currency) };
  } catch {
    return { ok: false, why: "amount has more fraction digits than the currency allows" };
  }
}

export function normalizeAccount(s: string): string {
  return s.normalize("NFKC").replace(/[\s.\-/]/g, "").toUpperCase();
}

export function checkAccount(value: string, evidence: string): { ok: boolean; why?: string } {
  const v = normalizeAccount(value);
  if (v.length < 4) return { ok: false, why: "account too short" };
  if (!normalizeAccount(evidence).includes(v)) return { ok: false, why: "account differs from evidence" };
  if (/^[A-Z]{2}\d{2}/.test(v) && v.length >= 15 && !isValidIban(v)) return { ok: false, why: "IBAN check digits invalid (ISO 7064 MOD 97-10)" };
  return { ok: true };
}

const CURRENCY_MARKERS: Record<string, RegExp> = {
  EUR: /EUR|€|euro/i,
  USD: /USD|US\$|\$|dollar/i,
  HUF: /HUF|Ft\b|forint/i,
  KZT: /KZT|₸|тг|тенге|теңге/i,
  CNY: /CNY|RMB|¥|元|人民币/i,
};

export function checkCurrency(value: string, evidence: string): { ok: boolean; why?: string } {
  const code = value.trim().toUpperCase();
  const re = CURRENCY_MARKERS[code];
  if (!re) return { ok: false, why: "unsupported currency" };
  return re.test(evidence) ? { ok: true } : { ok: false, why: "currency not in evidence" };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** ISO dates readable from the evidence (YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY, "31 October 2026", "October 31, 2026"). */
export function dateReadings(text: string): string[] {
  const out = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  const push = (y: number, m: number, d: number) => {
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.add(`${y}-${pad(m)}-${pad(d)}`);
  };
  for (const m of text.matchAll(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/g)) push(+m[1]!, +m[2]!, +m[3]!);
  for (const m of text.matchAll(/(\d{1,2})[./](\d{1,2})[./](\d{4})/g)) push(+m[3]!, +m[2]!, +m[1]!);
  for (const m of text.matchAll(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/g)) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    if (mo) push(+m[3]!, mo, +m[1]!);
  }
  for (const m of text.matchAll(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/g)) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    if (mo) push(+m[3]!, mo, +m[2]!);
  }
  return [...out];
}

export function checkDate(value: string, evidence: string): { ok: boolean; why?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return { ok: false, why: "date is not YYYY-MM-DD" };
  return dateReadings(evidence).includes(value.trim()) ? { ok: true } : { ok: false, why: "date differs from evidence" };
}

export function checkText(value: string, evidence: string): { ok: boolean; why?: string } {
  const v = normalizeSpace(value).toLowerCase();
  if (!v) return { ok: false, why: "empty" };
  return normalizeSpace(evidence).toLowerCase().includes(v) ? { ok: true } : { ok: false, why: "value not in evidence" };
}

export type FieldType = "amount" | "account" | "currency" | "date" | "text";

export function checkField(
  type: FieldType,
  field: { value: string | null; evidence: string | null },
  source: string,
  ctx: { currency: string | null },
): { check: FieldCheck; why?: string; amountMinor?: number } {
  if (field.value === null || field.value.trim() === "") return { check: "UNVERIFIED", why: "missing" };
  if (field.evidence === null || !evidenceInSource(field.evidence, source)) return { check: "UNVERIFIED", why: "evidence not found in source" };
  const r: { ok: boolean; why?: string; amountMinor?: number } =
    type === "amount"
      ? checkAmount(field.value, field.evidence, ctx.currency)
      : type === "account"
        ? checkAccount(field.value, field.evidence)
        : type === "currency"
          ? checkCurrency(field.value, field.evidence)
          : type === "date"
            ? checkDate(field.value, field.evidence)
            : checkText(field.value, field.evidence);
  if (!r.ok) return { check: "UNVERIFIED", why: r.why ?? "mismatch" };
  return r.amountMinor !== undefined ? { check: "VERIFIED", amountMinor: r.amountMinor } : { check: "VERIFIED" };
}
