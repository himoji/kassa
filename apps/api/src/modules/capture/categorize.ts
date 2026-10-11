import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeMerchant } from "./normalize.ts";

/*
 * Categorisation (spec §13): user correction for this merchantNorm (remembered) → ISO 18245 MCC map →
 * merchant dictionary (`fixtures/merchants.json`, Track D) → dictionary keywords (whole words of the merchant
 * text, e.g. "coffee" → eating_out; Track Y5, so a typed "coffee 1200 HUF" lands where the coffee-shop capture
 * does) → Reader-assisted fallback (caller supplies it; returns null when no model is available) → "other".
 * Capture and the agent's log_expense both go through ingestCapture → categorize (one categoriser).
 */

export interface MerchantEntry {
  merchantNorm: string;
  displayName: string;
  aliases: string[];
  category: string;
  mcc?: string;
}

export interface MerchantDictionary {
  categories: string[];
  mccToCategory: Record<string, string>;
  merchants: MerchantEntry[];
  /** category → lower-case words that name it ("coffee", "metro"); matched as whole words of merchantNorm. */
  keywords?: Record<string, string[]>;
}

/** ISO 18245 MCC ranges for the budget categories, used when the fixture is absent or lacks a code. */
export const DEFAULT_MCC_RANGES: Array<[number, number, string]> = [
  [4111, 4131, "transport"],
  [4784, 4789, "transport"],
  [4812, 4816, "phone"],
  [4900, 4900, "utilities"],
  [5411, 5499, "groceries"],
  [5811, 5814, "eating_out"],
  [5912, 5912, "health"],
  [5942, 5942, "books"],
  [6300, 6399, "insurance"],
  [6513, 6513, "rent"],
  [7832, 7832, "entertainment"],
  [7922, 7999, "entertainment"],
  [8011, 8099, "health"],
  [8211, 8299, "tuition"],
];

export const DEFAULT_CATEGORIES = ["groceries", "eating_out", "transport", "rent", "tuition", "insurance", "books", "health", "entertainment", "phone", "utilities", "shopping", "other"];

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../fixtures/merchants.json");
let dict: MerchantDictionary | null = null;

export function loadMerchantDictionary(path = FIXTURE): MerchantDictionary {
  if (dict && path === FIXTURE) return dict;
  let d: MerchantDictionary = { categories: DEFAULT_CATEGORIES, mccToCategory: {}, merchants: [] };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MerchantDictionary>;
      d = {
        categories: raw.categories?.length ? raw.categories : DEFAULT_CATEGORIES,
        mccToCategory: raw.mccToCategory ?? {},
        merchants: raw.merchants ?? [],
        keywords: raw.keywords ?? {},
      };
    } catch (e) {
      console.warn(`[capture] could not read ${path}`, e);
    }
  }
  if (path === FIXTURE) dict = d;
  return d;
}

export function categoryFromMcc(mcc: string | null | undefined, d = loadMerchantDictionary()): string | null {
  if (!mcc || !/^\d{4}$/.test(mcc)) return null;
  const direct = d.mccToCategory[mcc];
  if (direct) return direct;
  const n = Number(mcc);
  return DEFAULT_MCC_RANGES.find(([lo, hi]) => n >= lo && n <= hi)?.[2] ?? null;
}

export function lookupMerchant(merchantNorm: string, d = loadMerchantDictionary()): MerchantEntry | null {
  for (const m of d.merchants) {
    if (m.merchantNorm === merchantNorm) return m;
    if (m.aliases.some((a) => normalizeMerchant(a) === merchantNorm)) return m;
  }
  return null;
}

/** First category whose keyword is a whole word of the merchant text (category order = dictionary order). */
export function categoryFromKeywords(merchantNorm: string, d = loadMerchantDictionary()): string | null {
  const words = new Set(merchantNorm.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (words.size === 0) return null;
  for (const [category, list] of Object.entries(d.keywords ?? {})) {
    if (d.categories.includes(category) && list.some((k) => words.has(k.toLowerCase()))) return category;
  }
  return null;
}

export type CategorySource = "USER" | "MCC" | "DICTIONARY" | "READER" | "DEFAULT";

export interface CategorizeInput {
  merchantNorm: string;
  merchantRaw: string;
  mcc?: string | null;
  /** Remembered user correction for this merchantNorm. */
  userCategory?: string | null;
  /** Reader-assisted fallback; return null when unavailable. */
  readerFallback?: (merchantRaw: string, categories: string[]) => Promise<string | null>;
}

export async function categorize(i: CategorizeInput, d = loadMerchantDictionary()): Promise<{ category: string; source: CategorySource; mcc: string | null }> {
  const entry = lookupMerchant(i.merchantNorm, d);
  const mcc = i.mcc ?? entry?.mcc ?? null;
  if (i.userCategory) return { category: i.userCategory, source: "USER", mcc };
  const byMcc = categoryFromMcc(i.mcc ?? null, d);
  if (byMcc) return { category: byMcc, source: "MCC", mcc };
  if (entry) return { category: entry.category, source: "DICTIONARY", mcc };
  // Keywords live in the same dictionary fixture, so they report as DICTIONARY (no new CategorySource).
  const byKeyword = categoryFromKeywords(i.merchantNorm, d);
  if (byKeyword) return { category: byKeyword, source: "DICTIONARY", mcc };
  if (i.readerFallback) {
    let c: string | null = null;
    try {
      c = await i.readerFallback(i.merchantRaw, d.categories);
    } catch {
      c = null; // fallback unavailable (no model / sync throw / rejection): fall through to "other"
    }
    if (c && d.categories.includes(c)) return { category: c, source: "READER", mcc };
  }
  return { category: "other", source: "DEFAULT", mcc };
}
