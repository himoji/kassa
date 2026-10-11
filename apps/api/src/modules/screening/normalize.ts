/*
 * Name normalisation for screening (I9) and payee-name checks (handoff, spec §11):
 * transliterate non-Latin scripts to Latin (`transliteration`, covers Cyrillic incl. Kazakh letters),
 * Unicode NFKD + strip combining marks, lowercase, keep [a-z0-9], collapse whitespace.
 */
import { distance } from "fastest-levenshtein";
import { transliterate } from "transliteration";

import { jaroWinkler } from "./jaroWinkler.ts";

const LEGAL_SUFFIXES = new Set([
  "llc", "ltd", "limited", "inc", "gmbh", "kft", "zrt", "nyrt", "bt", "sa", "ag", "bv", "plc", "too", "ao", "oao", "ooo", "ip", "co", "zhshs", "llp",
]);

export function normalizeName(input: string, opts: { stripLegal?: boolean } = {}): string {
  const latin = transliterate(input.normalize("NFKC"));
  const tokens = latin
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const kept = opts.stripLegal ? tokens.filter((t) => !LEGAL_SUFFIXES.has(t)) : tokens;
  return kept.join(" ");
}

/** Tokens sorted, so "Ivanov Sergey" ~ "Sergey Ivanov". */
export function tokenSorted(normalized: string): string {
  return normalized.split(" ").filter(Boolean).sort().join(" ");
}

/**
 * Token-set score: every token of the shorter name is matched to its best Jaro-Winkler partner in the
 * longer one (handles omitted middle names / patronymics and word order). Mean of the best scores;
 * only for names of ≥ 2 tokens so one common first name never matches on its own.
 */
function tokenSetScore(a: string, b: string): number {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length < 2) return 0;
  let sum = 0;
  for (const t of short) {
    let best = 0;
    for (const u of long) best = Math.max(best, jaroWinkler(t, u));
    sum += best;
  }
  return sum / short.length;
}

/**
 * Similarity of two names in [0,1]: the best of Jaro-Winkler on the normalized strings, on the
 * token-sorted strings, the normalized Levenshtein ratio (1 - d / maxLen) on token-sorted strings, and
 * the token-set score.
 */
export function nameSimilarity(a: string, b: string, opts: { stripLegal?: boolean } = {}): number {
  const na = normalizeName(a, opts);
  const nb = normalizeName(b, opts);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  const sa = tokenSorted(na);
  const sb = tokenSorted(nb);
  const lev = 1 - distance(sa, sb) / Math.max(sa.length, sb.length);
  return Math.max(jaroWinkler(na, nb), jaroWinkler(sa, sb), lev, tokenSetScore(na, nb));
}
