import { isValidIban } from "@kassa/shared";

/*
 * Personal-data reduction before every planner call (spec §2 I11, §9 "Redaction").
 *
 * Detectors (standards cited per the standards-first rule, docs/DECISIONS.md):
 *  - IBAN: ISO 13616-1 shape (2-letter country, 2 check digits, BBAN), length checked against the
 *    SWIFT IBAN registry for the country; printed form may be grouped by 4 with spaces.
 *  - Card PAN: ISO/IEC 7812-1, 13–19 digits (optionally grouped by spaces/dashes) passing the Luhn
 *    check (ISO/IEC 7812-1 Annex B).
 *  - Email: RFC 5322 §3.4.1 addr-spec, dot-atom local part (the practical subset; no quoted strings).
 *  - Phone: ITU-T E.164, "+" followed by 8–15 digits, separators allowed.
 *  - Personal names: the user's profile name and payee names known to the server, matched
 *    case-insensitively on Unicode letter boundaries.
 *
 * Every hit becomes a stable placeholder for the conversation (same value → same placeholder).
 * The mapping lives in `placeholder_maps` (server only); `propose_order` resolves `payee_N` refs.
 */

export type PlaceholderKind = "PAYEE" | "PERSON" | "IBAN" | "CARD" | "EMAIL" | "PHONE";

export interface PlaceholderEntry {
  placeholder: string;
  kind: PlaceholderKind;
  /** PAYEE → payeeId; PERSON → name; others → the normalised raw value. Server-only. */
  realRef: string;
}

export interface KnownName {
  name: string;
  kind: "PAYEE" | "PERSON";
  /** PAYEE: payeeId. PERSON: the name itself. */
  ref: string;
  /** For people: also redact single name tokens (first / last name) of ≥ 3 letters. */
  personal?: boolean;
}

// ---------- IBAN (ISO 13616) ----------

/** SWIFT IBAN registry lengths for the countries Kassa meets plus common EU ones. */
export const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24,
  FI: 18, FR: 27, GB: 22, GE: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, KZ: 20, LI: 21,
  LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19,
  SK: 24, SM: 27, TR: 26, UA: 29, AZ: 28, KG: 26,
};

/** ISO 7064 MOD 97-10 check used by ISO 13616 (shared implementation). */
export { isValidIban };

// ---------- PAN (ISO/IEC 7812) ----------

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// ---------- detection ----------

interface Hit {
  start: number;
  end: number;
  kind: PlaceholderKind;
  /** Normalised value used for the stable mapping. */
  value: string;
  ref?: string;
}

const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,32}/g;
const PAN_CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
// RFC 5322 dot-atom addr-spec subset.
const EMAIL = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}/g;
// E.164: "+" then up to 15 digits; allow spaces, dots, dashes, parentheses between digits.
const PHONE = /\+\d(?:[\s().-]{0,2}\d){7,14}(?!\d)/g;

function ibanHits(text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    const country = m[0].slice(0, 2);
    const len = IBAN_LENGTHS[country];
    if (len === undefined || len === 0) continue;
    // Take exactly `len` alphanumerics from the start (the greedy match may run into a following word).
    let count = 0;
    let endRel = 0;
    for (let i = 0; i < m[0].length && count < len; i++) {
      if (m[0][i] !== " ") count++;
      endRel = i + 1;
    }
    if (count !== len) continue;
    const compact = m[0].slice(0, endRel).replace(/ /g, "");
    // Next char must not continue the token (avoid cutting a longer alphanumeric word).
    const next = text[m.index! + endRel];
    if (next && /[A-Za-z0-9]/.test(next)) continue;
    out.push({ start: m.index!, end: m.index! + endRel, kind: "IBAN", value: compact });
  }
  return out;
}

function panHits(text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(PAN_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, kind: "CARD", value: digits });
  }
  return out;
}

function regexHits(text: string, re: RegExp, kind: PlaceholderKind, norm: (s: string) => string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length, kind, value: norm(m[0]) });
  return out;
}

function phoneHits(text: string): Hit[] {
  return regexHits(text, PHONE, "PHONE", (s) => `+${s.replace(/\D/g, "")}`).filter((h) => {
    const n = h.value.length - 1;
    return n >= 8 && n <= 15;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameHits(text: string, names: KnownName[]): Hit[] {
  const out: Hit[] = [];
  const terms: Array<{ term: string; n: KnownName }> = [];
  for (const n of names) {
    const full = n.name.trim();
    if (full.length >= 2) terms.push({ term: full, n });
    if (n.personal) for (const tok of full.split(/\s+/)) if (tok.length >= 3 && tok !== full) terms.push({ term: tok, n });
  }
  // Longest first so "Dana Nurlanovna" wins over "Dana".
  terms.sort((a, b) => b.term.length - a.term.length);
  for (const { term, n } of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(term).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "giu");
    for (const m of text.matchAll(re)) {
      out.push({ start: m.index!, end: m.index! + m[0].length, kind: n.kind, value: n.kind === "PAYEE" ? n.ref : n.name, ref: n.ref });
    }
  }
  return out;
}

/** Non-overlapping hits, earliest first; on overlap the longer hit wins (ties: earlier detector order). */
function resolveOverlaps(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Hit[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) {
      if (h.end - h.start > last.end - last.start) out[out.length - 1] = h;
      continue;
    }
    out.push(h);
  }
  return out;
}

export function detect(text: string, names: KnownName[] = []): Hit[] {
  return resolveOverlaps([...ibanHits(text), ...panHits(text), ...regexHits(text, EMAIL, "EMAIL", (s) => s.toLowerCase()), ...phoneHits(text), ...nameHits(text, names)]);
}

// ---------- redactor ----------

const PREFIX: Record<PlaceholderKind, string> = {
  PAYEE: "payee",
  PERSON: "person",
  IBAN: "iban",
  CARD: "card",
  EMAIL: "email",
  PHONE: "phone",
};

/** Matches any placeholder this module emits. */
export const PLACEHOLDER_RE = /\b(?:payee|person|iban|card|email|phone)_\d+(?:_\d+)?\b/g;

export class Redactor {
  private readonly byKey = new Map<string, PlaceholderEntry>();
  private readonly byPlaceholder = new Map<string, PlaceholderEntry>();
  private readonly fresh: PlaceholderEntry[] = [];
  private names: KnownName[];

  constructor(opts: { names?: KnownName[]; existing?: PlaceholderEntry[] } = {}) {
    this.names = opts.names ?? [];
    for (const e of opts.existing ?? []) this.index(e);
  }

  setNames(names: KnownName[]): void {
    this.names = names;
  }

  private key(kind: PlaceholderKind, value: string): string {
    return `${kind}|${kind === "PERSON" ? value.toLowerCase() : value}`;
  }

  private index(e: PlaceholderEntry): void {
    this.byKey.set(this.key(e.kind, e.realRef), e);
    this.byPlaceholder.set(e.placeholder, e);
  }

  /** Stable placeholder for (kind, value); creates one if new. */
  placeholderFor(kind: PlaceholderKind, value: string): string {
    const k = this.key(kind, value);
    const hit = this.byKey.get(k);
    if (hit) return hit.placeholder;
    let placeholder: string;
    if (kind === "CARD") {
      // Spec §9 example `card_1234`: last 4 digits; disambiguate collisions with a suffix.
      const base = `card_${value.slice(-4)}`;
      placeholder = base;
      for (let i = 2; this.byPlaceholder.has(placeholder); i++) placeholder = `${base}_${i}`;
    } else {
      let n = 1;
      for (const p of this.byPlaceholder.keys()) {
        const m = new RegExp(`^${PREFIX[kind]}_(\\d+)$`).exec(p);
        if (m) n = Math.max(n, Number(m[1]) + 1);
      }
      placeholder = `${PREFIX[kind]}_${n}`;
    }
    const e: PlaceholderEntry = { placeholder, kind, realRef: value };
    this.index(e);
    this.fresh.push(e);
    return placeholder;
  }

  redactText(text: string): string {
    const hits = detect(text, this.names);
    if (hits.length === 0) return text;
    let out = "";
    let pos = 0;
    for (const h of hits) {
      out += text.slice(pos, h.start) + this.placeholderFor(h.kind, h.value);
      pos = h.end;
    }
    return out + text.slice(pos);
  }

  /** Deep-redact every string in a JSON-like value (object keys are left alone). */
  redactValue<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.redactText(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Uint8Array)) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }

  resolve(placeholder: string): PlaceholderEntry | undefined {
    return this.byPlaceholder.get(placeholder.trim());
  }

  /** Entries created since the last call (to persist into placeholder_maps). */
  drainNew(): PlaceholderEntry[] {
    return this.fresh.splice(0, this.fresh.length);
  }

  entries(): PlaceholderEntry[] {
    return [...this.byPlaceholder.values()];
  }

  /**
   * Text shown to the user (never sent to a model): names are restored; account-like values are shown
   * masked (IBAN country + last 4, card •••• last 4, masked email / phone).
   */
  rehydrateForUser(text: string, payeeNames: Map<string, string> = new Map()): string {
    return text.replace(PLACEHOLDER_RE, (p) => {
      const e = this.byPlaceholder.get(p);
      if (!e) return p;
      switch (e.kind) {
        case "PAYEE":
          return payeeNames.get(e.realRef) ?? p;
        case "PERSON":
          return e.realRef;
        case "IBAN":
          return `${e.realRef.slice(0, 2)}…${e.realRef.slice(-4)}`;
        case "CARD":
          return `•••• ${e.realRef.slice(-4)}`;
        case "EMAIL": {
          const [local = "", domain = ""] = e.realRef.split("@");
          return `${local.slice(0, 1)}…@${domain}`;
        }
        case "PHONE":
          return `+…${e.realRef.slice(-3)}`;
      }
    });
  }
}
