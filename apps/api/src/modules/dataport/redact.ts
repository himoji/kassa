import { Redactor, type KnownName } from "../agent/redact.ts";

/*
 * Statement text before any model sees it (IMPORT_PLAN safety rule 2). The agent's redactor handles IBANs (ISO 13616),
 * card numbers (Luhn), e-mail, E.164 phones and known names (the holder, the profile name). Statements carry more:
 *  - masked cards (441328******3273) → "•••• 3273" (the last 4 digits identify the card, never the account),
 *  - account numbers printed in groups (2260 0812 3336) and any run of 8+ digits: national ids (KZ IIN/BIN are 12),
 *    bank-internal account numbers, references → "[number]",
 *  - authorisation and confirmation codes → "[code]",
 *  - postal address lines (a US state + ZIP, a street line) → "[address]".
 * Amounts are never touched: they have at most 7 integer digits grouped by 3, and dates have separators.
 */

const MASKED_CARD = /\b\d{4,6}[*xX•]{4,}(\d{4})\b/g;
const GROUPED_NUMBER = /(?<![\d.,])\d{4}(?:[ -]\d{4}){2,4}(?!\d|[.,]\d)/g;
const LONG_NUMBER = /(?<!\d|\d[.,])\d{8,}(?!\d|[.,]\d)/g;
const CODES = /(?:Код\s*авторизации|Референс|Reference|Авторизация\s*коды|Auth(?:ori[sz]ation)?\s*code|Conf(?:irmation)?\s*#?|Ref(?:erence)?\s*(?:#|no\.?)|Trace\s*#|БИК|БСК|BIC|SWIFT)\s*[:#]?\s*[\w-]+/giu;
const US_ADDRESS = /^.*\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b.*$/gm;
const STREET = /^\s*\d+[A-Z]?\s+[\p{L}\d .'-]{2,40}\b(?:ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|LANE|LN|DR|DRIVE|WAY|PL|COURT|CT|NW|NE|SW|SE)\b.*$/gimu;
const LOCAL_ADDRESS = /^.*(?:\bул\.|\bулица\b|көшесі|\bпр\.|проспект|даңғылы|мкр\.?|шағын аудан|\bд\.\s*\d|\bкв\.\s*\d|\bпәтер\b).*$/gimu;

/** Feminine and case endings a family name takes in Russian and Kazakh ("Байжигитов" → "Байжигитова", "BAIZHIGITOVA"). */
const NAME_ENDINGS = ["a", "а", "у", "ой", "ым", "ых", "ым", "е"];

/**
 * The holder's names as redactor entries: the whole name, each name token of 3+ letters, and each family-name token
 * with its feminine and case endings, so a relative's "LYAZAT BAIZHIGITOVA" does not reveal the holder's surname.
 */
export function holderNames(names: string[]): KnownName[] {
  const full = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))];
  const variants = full.flatMap((n) =>
    n
      .split(/\s+/)
      .filter((t) => t.length >= 5)
      .flatMap((t) => NAME_ENDINGS.map((e) => (t === t.toUpperCase() ? t + e.toUpperCase() : t + e))),
  );
  return [...full, ...new Set(variants)].map((name) => ({ name, kind: "PERSON" as const, ref: name, personal: true }));
}

/** Redact one statement's text (see the header comment). `redactor` keeps placeholders stable across chunks. */
export function redactStatement(text: string, redactor: Redactor): string {
  // Addresses live in the header above the first transaction; rows are never matched by the address patterns.
  const firstRow = /^\s*(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/m.exec(text)?.index ?? text.length;
  const head = text.slice(0, firstRow).replace(US_ADDRESS, "[address]").replace(STREET, "[address]").replace(LOCAL_ADDRESS, "[address]");
  const pre = (head + text.slice(firstRow)).replace(MASKED_CARD, "•••• $1").replace(CODES, "[code]");
  // IBANs, PANs, e-mail, phones and names first (stable placeholders), then the remaining long numbers.
  return redactor.redactText(pre).replace(GROUPED_NUMBER, "[number]").replace(LONG_NUMBER, "[number]");
}

/** A new redactor for one import, knowing the holder's names. */
export function statementRedactor(names: string[]): Redactor {
  return new Redactor({ names: holderNames(names) });
}

/**
 * What must never reach a model: IBAN-shaped strings, 8+ digit runs, masked card numbers with more than the last 4
 * digits, and the given secrets (holder names, national ids). Returns the offending snippets (empty = clean).
 */
export function leaks(text: string, secrets: string[] = []): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g)) out.push(m[0]);
  for (const m of text.matchAll(LONG_NUMBER)) out.push(m[0]);
  for (const m of text.matchAll(MASKED_CARD)) out.push(m[0]);
  const lower = text.toLowerCase();
  for (const s of secrets) if (s.trim().length >= 3 && lower.includes(s.trim().toLowerCase())) out.push(s);
  return out;
}
