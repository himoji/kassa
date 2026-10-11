/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, expect, it } from "@jest/globals";

// Node built-ins via require: this file runs under jest-expo, where the Node modules are
// available but the app's own sources are never imported.
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const SRC = path.resolve(__dirname, "..");
const ROOT = path.resolve(SRC, "..");
const SCANNED_DIRS = ["screens", "components"].map((dir) => path.join(SRC, dir));

/** Vendor kit: its strings are the kit's own, reviewed separately. */
const EXCLUDED_PREFIX = "src/components/ui/";

const COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
/** Text children of a `<Text ...>` element, attributes may contain quoted strings and `{...}`. */
const TEXT_CHILD = /<Text\b(?:[^>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*>([^<{]+)/g;
/** `<Text>{"literal"}</Text>`: a string literal written as a JSX expression. */
const LITERAL_EXPR = /<Text\b[^>]*>\s*\{\s*["'`][^"'`]*\p{L}[^"'`]*["'`]\s*\}/gu;

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Returns the snippet of every raw (untranslated) letter-bearing string inside a `<Text>`. */
function scan(source: string): string[] {
  const code = source.replace(COMMENT, "");
  const found: string[] = [];
  for (const match of code.matchAll(TEXT_CHILD)) {
    const text = (match[1] ?? "").trim();
    if (/\p{L}/u.test(text)) found.push(snippet(text));
  }
  for (const match of code.matchAll(LITERAL_EXPR)) {
    found.push(snippet(match[0]));
  }
  return found;
}

function collectTsx(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") collectTsx(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

describe("no hardcoded UI strings", () => {
  it("every <Text> in screens and components uses translated content", () => {
    const files: string[] = [];
    for (const dir of SCANNED_DIRS) collectTsx(dir, files);
    // Guard against a vacuous pass if the folders move.
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(file);
      if (rel.startsWith(EXCLUDED_PREFIX)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const hit of scan(source)) violations.push(`${rel}: ${hit}`);
    }

    expect(violations).toEqual([]);
  });

  it("the scanner flags raw strings and accepts translated ones", () => {
    expect(scan('<Text variant="caption">Hello world</Text>')).toHaveLength(1);
    expect(scan('<Text>{t("home:title")}</Text>')).toHaveLength(0);
  });
});
