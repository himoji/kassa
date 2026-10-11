/*
 * Screening (I9, spec §10 step 4): fuzzy sanctions match including transliteration. A hit is
 * REFUSE_SANCTIONS. The list is loaded from fixtures/sanctions*.json (Track D, a sample of the EU
 * consolidated list); absent files mean an empty list (logged once), never a crash.
 *
 * Accepted file shapes: the EU Financial Sanctions Files (FSF) consolidated list rendered as JSON
 * (`export.sanctionEntity[].nameAlias[].wholeName`, id = logicalId); string[]; {name, aliases?}[];
 * or {entries|names|list: ...} of either.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nameSimilarity, normalizeName } from "./normalize.ts";

export { isValidIban, looksLikeIban, normalizeIban } from "./iban.ts";
export { jaroWinkler } from "./jaroWinkler.ts";
export { nameSimilarity, normalizeName } from "./normalize.ts";

/**
 * Match threshold. Jaro-Winkler ≥ 0.90 is a common screening cut-off; we use it on transliterated,
 * token-sorted names (so "Сергей Иванов" ~ "Ivanov Sergei").
 */
export const SANCTIONS_THRESHOLD = 0.9;

export type SanctionsEntry = { id: string; name: string; aliases: string[]; source?: string };
export type ScreeningResult =
  | { hit: false; score: number }
  | { hit: true; score: number; entryId: string; matchedName: string };

export const FIXTURES_DIR = fileURLToPath(new URL("../../../../../fixtures", import.meta.url));

let cache: SanctionsEntry[] | null = null;

function fsfEntries(raw: Record<string, unknown>, file: string): SanctionsEntry[] | null {
  const exp = raw.export as Record<string, unknown> | undefined;
  const list = exp?.sanctionEntity;
  if (!Array.isArray(list)) return null;
  const out: SanctionsEntry[] = [];
  for (const ent of list as Record<string, unknown>[]) {
    const aliases = Array.isArray(ent.nameAlias) ? (ent.nameAlias as Record<string, unknown>[]) : [];
    const names = aliases.map((a) => a.wholeName).filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.length === 0) continue;
    out.push({ id: String(ent.logicalId ?? ent.euReferenceNumber ?? `${file}#${out.length}`), name: names[0]!, aliases: names.slice(1), source: file });
  }
  return out;
}

function toEntries(raw: unknown, file: string): SanctionsEntry[] {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const fsf = fsfEntries(raw as Record<string, unknown>, file);
    if (fsf) return fsf;
  }
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).entries ??
        (raw as Record<string, unknown>).names ??
        (raw as Record<string, unknown>).list ??
        [])
      : [];
  if (!Array.isArray(arr)) return [];
  const out: SanctionsEntry[] = [];
  arr.forEach((item, i) => {
    if (typeof item === "string") {
      out.push({ id: `${file}#${i}`, name: item, aliases: [], source: file });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : typeof o.wholeName === "string" ? o.wholeName : null;
      if (!name) return;
      const aliasesRaw = o.aliases ?? o.akas ?? o.nameAliases ?? [];
      const aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw
            .map((a) => (typeof a === "string" ? a : a && typeof a === "object" ? (a as Record<string, unknown>).name : null))
            .filter((a): a is string => typeof a === "string")
        : [];
      for (const k of ["original", "originalName", "nameOriginal", "cyrillic", "transliterated"]) {
        if (typeof o[k] === "string") aliases.push(o[k] as string);
      }
      out.push({ id: typeof o.id === "string" ? o.id : `${file}#${i}`, name, aliases, source: file });
    }
  });
  return out;
}

export function loadSanctions(dir = FIXTURES_DIR): SanctionsEntry[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^sanctions.*\.json$/i.test(f));
  } catch {
    files = [];
  }
  const entries: SanctionsEntry[] = [];
  for (const f of files) {
    try {
      entries.push(...toEntries(JSON.parse(readFileSync(join(dir, f), "utf8")), f));
    } catch (err) {
      console.warn(`[screening] could not read ${f}: ${(err as Error).message}`);
    }
  }
  if (entries.length === 0 && process.env.NODE_ENV !== "test") {
    console.warn("[screening] no sanctions list found in fixtures/ — screening runs against an empty list");
  }
  return entries;
}

export function sanctionsList(): SanctionsEntry[] {
  if (!cache) cache = loadSanctions();
  return cache;
}

/** Tests: replace the list (null = reload from fixtures on next use). */
export function setSanctionsListForTests(list: SanctionsEntry[] | null): void {
  cache = list;
}

export function screenName(name: string, list: SanctionsEntry[] = sanctionsList()): ScreeningResult {
  // Very short queries (a single short token like "Dana") match too much to be meaningful.
  if (normalizeName(name, { stripLegal: true }).replace(/\s/g, "").length < 4) return { hit: false, score: 0 };
  let best: ScreeningResult = { hit: false, score: 0 };
  for (const e of list) {
    for (const candidate of [e.name, ...e.aliases]) {
      // Legal-form suffixes (LLC, OOO, Kft…) are not identifying: strip them on both sides.
      const score = nameSimilarity(name, candidate, { stripLegal: true });
      if (score >= SANCTIONS_THRESHOLD && (!best.hit || score > best.score)) {
        best = { hit: true, score, entryId: e.id, matchedName: candidate };
      } else if (!best.hit && score > best.score) {
        best = { hit: false, score };
      }
    }
  }
  return best;
}
