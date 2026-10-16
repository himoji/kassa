/**
 * Every locale carries exactly the English keys, with the same {{placeholders}} per key, and
 * the plural forms its language needs (i18next v4 JSON: `key_one`, `key_few`, ... chosen by
 * `Intl.PluralRules`, so `zh` has only `_other`, `ru` has `_one/_few/_many/_other`).
 */
import { describe, expect, it } from "@jest/globals";

import { en } from "../en";
import { kk } from "../kk";
import { ru } from "../ru";
import { zh } from "../zh";

type Tree = { [key: string]: string | Tree };

const LOCALES: Record<string, Record<string, unknown>> = { zh, ru, kk };

const PLURAL = /_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;
const PRODUCT_NAMES = ["KassaLite", "Kassa"];

/** Leaf strings keyed by dotted path. */
function flatten(tree: unknown, prefix = "", out: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(tree as Tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""))].sort();
}

/** Plain keys, and plural bases with their forms. */
function split(strings: Record<string, string>) {
  const plain: string[] = [];
  const plurals: Record<string, string[]> = {};
  for (const key of Object.keys(strings)) {
    const match = PLURAL.exec(key);
    if (match) {
      const base = key.slice(0, match.index);
      (plurals[base] ??= []).push(match[1] ?? "");
    } else plain.push(key);
  }
  return { plain: plain.sort(), plurals };
}

const namespaces = Object.keys(en) as (keyof typeof en)[];

describe.each(Object.keys(LOCALES))("locale %s", (lng) => {
  const locale = LOCALES[lng] ?? {};
  const rules = new Intl.PluralRules(lng);
  const forms = [...rules.resolvedOptions().pluralCategories].sort();
  const oneIsSingular = Array.from({ length: 200 }, (_, n) => n).every(
    (n) => n === 1 || rules.select(n) !== "one"
  );

  it("has exactly the English namespaces", () => {
    expect(Object.keys(locale).sort()).toEqual([...namespaces].sort());
  });

  describe.each(namespaces)("%s", (ns) => {
    const source = flatten(en[ns]);
    const target = flatten(locale[ns] ?? {});
    const s = split(source);
    const t = split(target);

    it("has the English keys, plural bases and no others", () => {
      expect(t.plain).toEqual(s.plain);
      expect(Object.keys(t.plurals).sort()).toEqual(Object.keys(s.plurals).sort());
    });

    it("has every plural form the language needs", () => {
      for (const base of Object.keys(s.plurals)) {
        expect({ base, forms: [...(t.plurals[base] ?? [])].sort() }).toEqual({ base, forms });
      }
    });

    it("keeps the placeholders of each key", () => {
      for (const key of s.plain) {
        expect({ key, vars: placeholders(target[key] ?? "") }).toEqual({
          key,
          vars: placeholders(source[key] ?? ""),
        });
      }
      for (const base of Object.keys(s.plurals)) {
        // Every form takes the English `_other` placeholders: ru `_one` also reads 21, 31, ...
        // Only a `_one` that means exactly 1 (kk) may drop them like the English `_one` does.
        const other = placeholders(source[`${base}_other`] ?? "");
        const one = placeholders(source[`${base}_one`] ?? "");
        for (const form of t.plurals[base] ?? []) {
          const key = `${base}_${form}`;
          const vars = placeholders(target[key] ?? "");
          const allowed = form === "one" && oneIsSingular ? [other, one] : [other];
          expect({ key, ok: allowed.some((a) => a.join() === vars.join()) }).toEqual({
            key,
            ok: true,
          });
        }
      }
    });

    it("keeps product names untranslated and leaves no string empty", () => {
      for (const [key, text] of Object.entries(target)) {
        expect({ key, empty: text.trim() === "" }).toEqual({ key, empty: false });
      }
      for (const key of s.plain) {
        const text = source[key] ?? "";
        const name = PRODUCT_NAMES.find((n) => text.includes(n));
        if (name)
          expect({ key, kept: (target[key] ?? "").includes(name) }).toEqual({ key, kept: true });
      }
    });
  });
});
