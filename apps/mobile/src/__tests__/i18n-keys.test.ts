/**
 * Every literal namespaced key passed to `t("ns:key")` in app code must exist in the English
 * resources, so a typo or a forgotten string fails CI instead of rendering the raw key.
 * Dynamic keys (`t(\`payees:kind.${kind}\`)`) are covered by their enum tests.
 */
import { describe, expect, it } from "@jest/globals";

import { en } from "@/locales/en";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs") as typeof import("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path") as typeof import("node:path");

const SRC = path.join(__dirname, "..");
const KEY = /\bt\(\s*["']([a-zA-Z]+):([\w.]+)["']/g;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "__tests__" || d.name === "locales" ? [] : files(p);
    return /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

function lookup(ns: string, key: string): unknown {
  let node: unknown = (en as Record<string, unknown>)[ns];
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Plural keys resolve through `_one` / `_other` suffixes (i18next v4 JSON, CLDR plural rules). */
function exists(ns: string, key: string): boolean {
  const v = lookup(ns, key) ?? lookup(ns, `${key}_other`);
  return typeof v === "string" && v.length > 0;
}

export function usedKeys(): { file: string; key: string }[] {
  return files(SRC).flatMap((file) => {
    const text = fs.readFileSync(file, "utf8");
    return [...text.matchAll(KEY)].map((m) => ({
      file: path.relative(SRC, file),
      key: `${m[1]}:${m[2]}`,
    }));
  });
}

describe("i18n keys", () => {
  it("every literal t() key exists in en", () => {
    const missing = usedKeys()
      .filter(({ key }) => {
        const [ns, k] = key.split(":") as [string, string];
        return !exists(ns, k);
      })
      .map(({ file, key }) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });
});
