import { isValidIban } from "@kassa/shared";
import { createHmac, hkdfSync } from "node:crypto";

import { env } from "../../env.ts";

/*
 * Personal-data reduction before every planner call (spec §2 I11, §9 "Redaction").
 *
 * Detectors (standards cited per the standards-first rule, docs/DECISIONS.md):
 *  - IBAN: ISO 13616-1 shape (2-letter country, 2 check digits, BBAN), length checked against the
 *    SWIFT IBAN registry for the country; printed form may be grouped by 4 with spaces.
 *  - Card PAN: ISO/IEC 7812-1, 13–19 digits (optionally grouped by spaces/dashes) passing the Luhn
 *    check (ISO/IEC 7812-1 Annex B), as a whole token: not glued to letters/digits/underscore and not part of
 *    a hyphen-joined identifier ("ab-4111-…-cd").
 *  - Identifiers are never redacted: no hit may overlap an RFC 9562 UUID (8-4-4-4-12 hex), so proposal or
 *    payment ids reach the model intact (p3 B3: "588fc665-2092-4241-93b7-…" became "588fccard_4193b7-…").
 *  - Email: RFC 5322 §3.4.1 addr-spec, dot-atom local part (the practical subset; no quoted strings).
 *  - Phone: ITU-T E.164, "+" followed by 8–15 digits, separators allowed.
 *  - Personal names: the user's profile name and payee names known to the server, matched
 *    case-insensitively on Unicode letter boundaries. A payee name matches only as the whole name
 *    (so "Landlord in Budapest" never redacts the word LANDLORD); a person's name also matches a
 *    single first/last-name token of ≥ 3 letters.
 *  - Enum/code fields (ENUM_KEYS: kind, payeeKind, status, …) are never redacted in tool outputs.
 *
 * Every hit becomes a stable placeholder for the conversation (same value → same placeholder). Payee
 * placeholders are keyed by payee id, never by name: two payees with the same name (an account change creates a
 * new payee, I7) get distinct placeholders. A name shared by several payees is resolved with the caller's
 * context (`{ payeeId }`, e.g. the payee a tool output is about), else to the first payee in `names` order.
 * The mapping lives in `placeholder_maps` (server only); `propose_order` resolves `payee_N` refs.
 * Card numbers are never stored (PCI DSS v4.0 Req. 3.3/3.5.1): a CARD entry's realRef is
 * "pan:<HMAC-SHA256 digest>:<last4>" — a keyed hash (stable within the conversation) plus the last 4 digits
 * that rehydration shows as "•••• 1234".
 */

let panKey: { kek: string; key: Buffer } | null = null;
/** Key for PAN digests, derived from USER_KEK with HKDF (RFC 5869) under its own label. */
function panHmacKey(): Buffer {
  const kek = env().USER_KEK;
  if (!panKey || panKey.kek !== kek) panKey = { kek, key: Buffer.from(hkdfSync("sha256", Buffer.from(kek, "base64"), Buffer.alloc(0), "kassa:pan-ref:v1", 32)) };
  return panKey.key;
}

/** Stored reference for a card number: keyed digest + last 4, never the PAN itself. */
export function panRef(digits: string): string {
  const d = createHmac("sha256", panHmacKey()).update(digits, "utf8").digest("base64url").slice(0, 22);
  return `pan:${d}:${digits.slice(-4)}`;
}

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
  /** PAYEE: the payee's kind. Natural persons (PERSON, OWN_ACCOUNT) get token matching; organisations never do. */
  payeeKind?: string;
  /** Natural persons only: also redact single name tokens (first / last name) of ≥ 3 letters. */
  personal?: boolean;
}

/** Payee kinds that are natural persons (their surname is personal data, I11); all others are organisations. */
const NATURAL_PAYEE_KINDS: ReadonlySet<string> = new Set(["PERSON", "OWN_ACCOUNT"]);

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
  /** PAYEE name hits: every payee id that carries this exact name (length > 1 = ambiguous). */
  refs?: string[];
}

/** Context for one redaction: the payee the text is about (disambiguates payees that share a name). */
export interface RedactContext {
  payeeId?: string | undefined;
}

const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,32}/g;
// Whole token only: not preceded/followed by a letter, digit or underscore, nor hyphen-joined to one (identifiers).
const PAN_CANDIDATE = /(?<![\p{L}\p{N}_]|[\p{L}\p{N}_]-)(?:\d[ -]?){12,18}\d(?![\p{L}\p{N}_]|-[\p{L}\p{N}_])/gu;
// RFC 9562 §4 UUID text form (any version), case-insensitive.
const UUID = /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi;
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
  const terms: Array<{ term: string; n: KnownName; refs: string[] }> = [];
  const byTerm = new Map<string, { term: string; n: KnownName; refs: string[] }>();
  const add = (term: string, n: KnownName) => {
    const k = `${n.kind}|${term.toLowerCase().replace(/\s+/g, " ")}`;
    const t = byTerm.get(k);
    if (t) {
      if (n.kind === "PAYEE" && !t.refs.includes(n.ref)) t.refs.push(n.ref);
      return;
    }
    const e = { term, n, refs: [n.ref] };
    byTerm.set(k, e);
    terms.push(e);
  };
  for (const n of names) {
    const full = n.name.trim();
    if (full.length >= 2) add(full, n);
    const natural = n.kind === "PERSON" || NATURAL_PAYEE_KINDS.has(n.payeeKind ?? "");
    if (natural && n.personal) for (const tok of full.split(/\s+/)) if (tok.length >= 3 && tok !== full) add(tok, n);
  }
  // Longest first so "Dana Nurlanovna" wins over "Dana".
  terms.sort((a, b) => b.term.length - a.term.length);
  for (const { term, n, refs } of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(term).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "giu");
    for (const m of text.matchAll(re)) {
      out.push({ start: m.index!, end: m.index! + m[0].length, kind: n.kind, value: n.kind === "PAYEE" ? n.ref : n.name, ref: n.ref, ...(n.kind === "PAYEE" ? { refs } : {}) });
    }
  }
  return out;
}

/** Spans of identifiers (UUIDs) that no detector may touch. */
function identifierSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(UUID)].map((m) => [m.index!, m.index! + m[0].length]);
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
  const ids = identifierSpans(text);
  const outsideIds = (h: Hit) => !ids.some(([s, e]) => h.start < e && h.end > s);
  return resolveOverlaps([...ibanHits(text), ...panHits(text), ...regexHits(text, EMAIL, "EMAIL", (s) => s.toLowerCase()), ...phoneHits(text), ...nameHits(text, names)].filter(outsideIds));
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

/**
 * Keys whose values hold enums or codes (never personal data). `redactValue` passes these values through
 * verbatim, so a payee named "Verified Shop" cannot turn status "VERIFIED" into a placeholder.
 */
export const ENUM_KEYS: ReadonlySet<string> = new Set([
  "kind", "payeeKind", "status", "decision", "reasonCodes", "reasonCode", "rail", "currency", "homeCurrency", "category",
  "preset", "moneyMode", "region", "tier", "source", "type", "cadence", "recurrence", "period", "notificationMode",
]);

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
  placeholderFor(kind: PlaceholderKind, raw: string): string {
    const value = kind === "CARD" && /^\d{12,19}$/.test(raw) ? panRef(raw) : raw;
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

  redactText(text: string, ctx: RedactContext = {}): string {
    const hits = detect(text, this.names);
    if (hits.length === 0) return text;
    let out = "";
    let pos = 0;
    for (const h of hits) {
      // Ambiguous payee name: the payee this text is about wins (keyed by id, p3 B4).
      const value = h.refs && ctx.payeeId && h.refs.includes(ctx.payeeId) ? ctx.payeeId : h.value;
      out += text.slice(pos, h.start) + this.placeholderFor(h.kind, value);
      pos = h.end;
    }
    return out + text.slice(pos);
  }

  /** Deep-redact every string in a JSON-like value (object keys are left alone; ENUM_KEYS values verbatim). */
  redactValue<T>(value: T, ctx: RedactContext = {}): T {
    const walk = (v: unknown, key?: string): unknown => {
      if (key !== undefined && ENUM_KEYS.has(key)) return v;
      if (typeof v === "string") return this.redactText(v, ctx);
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Uint8Array)) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
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
