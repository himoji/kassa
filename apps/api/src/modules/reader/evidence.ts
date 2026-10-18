import { IBAN_LENGTHS, isKnownCurrency, isValidRfReference, toMinor, type FieldCheck } from "@kassa/shared";

import { isValidIban } from "../agent/redact.ts";

/*
 * Server-side checks of Reader output against the source (spec §9, I10):
 *  1. evidence is a substring of the extracted source text (exact; then after Unicode NFKC + whitespace
 *     collapse, since PDF text extraction is not whitespace-stable);
 *  2. the value is consistent with its evidence — numbers re-parsed from the evidence must equal the
 *     parsed value; accounts must appear in the evidence as a whole account (and IBAN-shaped values must be
 *     complete IBANs passing ISO 7064 MOD 97-10);
 *  3. (added 2026-10-18, docs/evidence/invoice-eval.json) plausibility against the whole document: a payee that
 *     is the account holder herself (the "Bill to" name) is not accepted, and a payment reference must look like
 *     one (not a date, an amount, an IBAN, a label or a "no reference required" note) and, when the document
 *     prints a reference next to a payment-reference label, must be that value rather than e.g. the invoice number.
 *  Every rejection is UNVERIFIED with a reason, so the user is asked; nothing here ever verifies more.
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

/** Starts like an IBAN of a known country (ISO 13616: country code + 2 check digits). */
function ibanShaped(v: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]/.test(v) && IBAN_LENGTHS[v.slice(0, 2)] !== undefined;
}

export function checkAccount(value: string, evidence: string): { ok: boolean; why?: string } {
  const v = normalizeAccount(value);
  if (v.length < 4) return { ok: false, why: "account too short" };
  const ev = normalizeAccount(evidence);
  const at = ev.indexOf(v);
  if (at === -1) return { ok: false, why: "account differs from evidence" };
  // An IBAN-shaped value must be a whole IBAN (country length + check digits), so a truncated IBAN never passes.
  if (ibanShaped(v) || (/^[A-Z]{2}\d{2}/.test(v) && v.length >= 15)) {
    if (!isValidIban(v)) return { ok: false, why: "IBAN incomplete or check digits invalid (ISO 13616, ISO 7064 MOD 97-10)" };
    return { ok: true };
  }
  // Other account numbers: the whole number, not a run of digits cut out of a longer one.
  const before = ev[at - 1];
  const after = ev[at + v.length];
  // (Separators are stripped, so a label glued in front, "ACCOUNT1177…", is fine; a digit on either side is not.)
  if ((before !== undefined && /\d/.test(before) && /\d/.test(v[0]!)) || (after !== undefined && /\d/.test(after) && /\d/.test(v[v.length - 1]!))) {
    return { ok: false, why: "account is only part of the number in the evidence" };
  }
  return { ok: true };
}

// Codes and words as whole tokens ("EUR" not inside "EUROPA", "Ft" not the end of "Gift"); a "$" glued to letters
// is another dollar (C$, A$, HK$), except US$.
const CURRENCY_MARKERS: Record<string, RegExp> = {
  EUR: /(?<![A-Za-z])EUR(?![A-Za-z])|€|(?<![A-Za-z])euros?(?![A-Za-z])/i,
  USD: /(?<![A-Za-z])USD(?![A-Za-z])|US\$|(?<![A-Za-z])\$|(?<![A-Za-z])dollars?(?![A-Za-z])/i,
  HUF: /(?<![A-Za-z])HUF(?![A-Za-z])|(?<![A-Za-z])Ft(?![A-Za-z])|(?<![A-Za-z])forint/i,
  KZT: /(?<![A-Za-z])KZT(?![A-Za-z])|₸|(?<![а-яА-Я])тг(?![а-яА-Я])|тенге|теңге/i,
  CNY: /(?<![A-Za-z])(?:CNY|RMB)(?![A-Za-z])|¥|元|人民币/i,
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

// ---------- payee: not the account holder ----------

/** Lower-case letter/digit tokens without diacritics ("Seitkalí, Dana" → ["seitkali", "dana"]). */
function nameTokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * True when `name` is the account holder (one of her names: display name, legal name). The same tokens in any
 * order, or one name's tokens all within the other's with at most one extra (a display name "Dana" against
 * "Dana Seitkali" on the invoice, or the reverse). Single-letter tokens (initials) are ignored.
 */
export function isAccountHolderName(name: string, holderNames: readonly string[]): boolean {
  const p = new Set(nameTokens(name).filter((t) => t.length > 1));
  if (p.size === 0) return false;
  for (const holder of holderNames) {
    const h = new Set(nameTokens(holder).filter((t) => t.length > 1));
    if (h.size === 0) continue;
    const [small, big] = h.size <= p.size ? [h, p] : [p, h];
    if ([...small].every((t) => big.has(t)) && big.size - small.size <= 1) return true;
  }
  return false;
}

export function checkPayee(value: string, evidence: string, holderNames: readonly string[]): { ok: boolean; why?: string } {
  const t = checkText(value, evidence);
  if (!t.ok) return t;
  if (isAccountHolderName(value, holderNames)) return { ok: false, why: "payee is the account holder (the person billed), not the creditor" };
  return { ok: true };
}

// ---------- payment reference ----------

/*
 * Labels a payment reference is printed after (en, de, hu, fr; ISO 20022 "remittance information" in practice).
 * Invoice-number labels (Invoice no., Rechnungsnummer, Számlaszám, N° de facture) are deliberately not here: the
 * invoice number is the reference only when the document prints no payment reference of its own.
 */
const REFERENCE_LABEL =
  /(?<![\p{L}\p{N}])(?:payment\s+reference|remittance\s+information|reference(?:\s+(?:number|no\.?))?|ref\.|purpose(?:\s+of\s+payment)?|student\s+(?:id|number|no\.?)|verwendungszweck|zahlungsreferenz|mitteilung|matrikelnummer|közlemény|hallgatói\s+azonosító|neptun(?:\s+kód|\s+code)?|référence(?:\s+à\s+rappeler)?|motif\s+du\s+virement|libellé)(?![\p{L}\p{N}])\s*[:#]?\s*/giu;

/** Labels of an invoice's own fields: a reference that is only a label was copied from the wrong place. */
const FIELD_LABEL =
  /^(?:payment\s+reference|reference|ref\.?|purpose|verwendungszweck|közlemény|référence(?:\s+à\s+rappeler)?|invoice(?:\s+(?:no\.?|number))?|rechnung(?:snummer)?|számla(?:szám)?|facture|n°\s+de\s+facture|iban|bic|swift|amount(?:\s+due)?|total|due\s+date|date|beneficiary|kedvezményezett|kontoinhaber|titulaire\s+du\s+compte|zahlbetrag|végösszeg|esedékesség|échéance|student\s+id)[\s:.#]*$/iu;

/** "No payment reference required", "Kein Verwendungszweck erforderlich", "Közlemény nem szükséges", "n/a". */
const NO_REFERENCE =
  /(?<![\p{L}])(?:no\s+(?:payment\s+)?reference|(?:reference\s+)?not\s+required|none|n\/a|kein(?:e)?\s+verwendungszweck|nicht\s+erforderlich|nem\s+szükséges|nincs|aucune\s+référence|pas\s+de\s+référence|sans\s+référence)(?![\p{L}])/iu;

const squash = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
const trimRef = (s: string) => s.trim().replace(/[\s,;:.)]+$/u, "").replace(/^[\s(:#]+/u, "");

export interface LabelledReference {
  /** The label as printed, e.g. "Verwendungszweck". */
  label: string;
  /** The text after the label (same line, else the next line), up to a comma or semicolon. */
  text: string;
  /** The document says no reference is needed. */
  none: boolean;
}

/** Every value the document prints after a payment-reference label (same line, or the next line for stacked layouts). */
export function labelledReferences(source: string): LabelledReference[] {
  const lines = source.normalize("NFKC").split(/\r?\n/);
  const out: LabelledReference[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A "No payment reference required" line is a note (read as the value of a label on the line before), not a label.
    if (NO_REFERENCE.test(line) && !new RegExp(REFERENCE_LABEL.source, "iu").test(line.replace(NO_REFERENCE, ""))) continue;
    let consumedTo = 0;
    for (const m of line.matchAll(REFERENCE_LABEL)) {
      if (m.index! < consumedTo) continue; // a label word inside the previous label's value ("Kein Verwendungszweck …")
      const start = m.index! + m[0].length;
      const rest = line.slice(start);
      // The value ends at the next label on the same line ("Reference: X  IBAN: Y") or at prose after a comma.
      let text = rest.split(/[,;]|\s{2,}|\s(?=(?:IBAN|BIC|SWIFT|Due date|Amount)\b)/i)[0] ?? "";
      consumedTo = start + text.length;
      if (!text.trim()) text = (lines[i + 1] ?? "").split(/[,;]/)[0] ?? "";
      text = trimRef(text);
      if (!text) continue;
      out.push({ label: m[0].trim().replace(/[\s:#]+$/u, ""), text, none: NO_REFERENCE.test(text) });
    }
  }
  return out;
}

function looksLikeDate(v: string): boolean {
  const t = v.trim();
  const shaped =
    /^\d{4}[-./]\d{1,2}[-./]\d{1,2}\.?$/.test(t) ||
    /^\d{1,2}[./]\d{1,2}[./]\d{4}\.?$/.test(t) ||
    /^\d{1,2}\.?\s+\p{L}+\.?,?\s+\d{4}$/u.test(t) ||
    /^\p{L}+\.?\s+\d{1,2},?\s+\d{4}$/u.test(t);
  return shaped && (dateReadings(t).length > 0 || /^\d{1,2}\.?\s+\p{L}+\.?,?\s+\d{4}$/u.test(t));
}

function looksLikeAmount(v: string, amount: string | null): boolean {
  const t = v.trim();
  // With a currency marker, or with exactly two decimals ("105,91", "2 400.00"): money, not a reference.
  if (/^(?:[€$£¥₸]|EUR|USD|HUF|KZT|CNY|Ft)?\s*\d[\d\s.,'’]*\s*(?:[€$£¥₸]|EUR|USD|HUF|KZT|CNY|Ft)?$/iu.test(t)) {
    if (/[€$£¥₸]|EUR|USD|HUF|KZT|CNY|Ft/iu.test(t)) return true;
    if (/^\d{1,3}(?:[\s.,'’]\d{3})*[.,]\d{2}$|^\d+[.,]\d{2}$/u.test(t)) return true;
    // A plain number that is the invoice's own amount.
    if (amount && numberReadings(t).some((r) => sameDecimal(r, amount.trim()))) return true;
  }
  return false;
}

/**
 * Plausibility of a payment reference (UNVERIFIED with a reason otherwise):
 *  - not a "no reference required" note, an invoice label, a date, an amount, or an IBAN / the payee's account
 *    (an ISO 11649 RF creditor reference is a reference, though it shares the MOD 97-10 check);
 *  - when the document prints a value after a payment-reference label, the reference must be one of those values
 *    (the invoice number next to it is then the wrong field), and if the document only says no reference is needed,
 *    there is none to accept.
 */
export function checkReference(
  value: string,
  evidence: string,
  source: string,
  ctx: { amount?: string | null; account?: string | null } = {},
): { ok: boolean; why?: string } {
  const v = value.normalize("NFKC").trim();
  const inEvidence = checkText(v, evidence).ok || squash(evidence).includes(squash(v));
  if (!inEvidence) return { ok: false, why: "value not in evidence" };
  if (NO_REFERENCE.test(v)) return { ok: false, why: "the document says no payment reference is needed" };
  if (FIELD_LABEL.test(v)) return { ok: false, why: "reference is a label, not a value" };
  if (!/[\p{L}\p{N}]/u.test(v)) return { ok: false, why: "reference has no letters or digits" };
  if (looksLikeDate(v)) return { ok: false, why: "reference is a date" };
  if (looksLikeAmount(v, ctx.amount ?? null)) return { ok: false, why: "reference is an amount" };
  const sv = squash(v);
  if (!isValidRfReference(sv) && (isValidIban(sv) || (ctx.account && normalizeAccount(ctx.account) === normalizeAccount(v)))) {
    return { ok: false, why: "reference is an account number" };
  }

  const labelled = labelledReferences(source);
  const values = labelled.filter((l) => !l.none);
  if (values.length > 0) {
    const ok = values.some((l) => squash(l.text) === sv || squash(l.text.split(/\s+/)[0] ?? "") === sv);
    if (!ok) return { ok: false, why: `not the reference printed after "${values[0]!.label}"` };
  } else if (labelled.length > 0) {
    return { ok: false, why: "the document says no payment reference is needed" };
  }
  return { ok: true };
}

export type FieldType = "amount" | "account" | "currency" | "date" | "text" | "payee" | "reference";

export interface FieldContext {
  currency: string | null;
  /** The account holder's own names (display / legal name): never accepted as the payee. */
  accountHolderNames?: readonly string[];
  /** The extraction's raw amount and account values, so a reference cannot be one of them. */
  amount?: string | null;
  account?: string | null;
}

export function checkField(
  type: FieldType,
  field: { value: string | null; evidence: string | null },
  source: string,
  ctx: FieldContext,
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
            : type === "payee"
              ? checkPayee(field.value, field.evidence, ctx.accountHolderNames ?? [])
              : type === "reference"
                ? checkReference(field.value, field.evidence, source, { amount: ctx.amount ?? null, account: ctx.account ?? null })
                : checkText(field.value, field.evidence);
  if (!r.ok) return { check: "UNVERIFIED", why: r.why ?? "mismatch" };
  return r.amountMinor !== undefined ? { check: "VERIFIED", amountMinor: r.amountMinor } : { check: "VERIFIED" };
}
