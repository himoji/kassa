/**
 * Prettier for generated TS. Uses the standalone build: prettier 3's CJS entry
 * dynamic-imports ESM, which jest (CJS, no vm-modules) cannot load.
 */
import fs from "node:fs";
import path from "node:path";

import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as markdown from "prettier/plugins/markdown";
import * as postcss from "prettier/plugins/postcss";
import * as typescript from "prettier/plugins/typescript";
import type { Options } from "prettier";
import { format } from "prettier/standalone";

/** Mirrors the repo `.prettierrc`; used when a root has none. */
export const DEFAULT_PRETTIER_OPTIONS: Options = {
  singleQuote: false,
  semi: true,
  trailingComma: "es5",
  printWidth: 100,
};

export function loadPrettierOptions(root: string): Options {
  const rc = path.join(root, ".prettierrc");
  if (!fs.existsSync(rc)) return DEFAULT_PRETTIER_OPTIONS;
  try {
    return { ...DEFAULT_PRETTIER_OPTIONS, ...(JSON.parse(fs.readFileSync(rc, "utf8")) as Options) };
  } catch {
    return DEFAULT_PRETTIER_OPTIONS;
  }
}

export async function formatTs(source: string, options: Options = DEFAULT_PRETTIER_OPTIONS) {
  return format(source, {
    ...options,
    parser: "typescript",
    plugins: [estree, typescript],
  });
}

export async function formatJson(source: string, options: Options = DEFAULT_PRETTIER_OPTIONS) {
  return format(source, { ...options, parser: "json", plugins: [estree, babel] });
}

export async function formatCss(source: string, options: Options = DEFAULT_PRETTIER_OPTIONS) {
  return format(source, { ...options, parser: "css", plugins: [postcss] });
}

/** Pick the parser from the file extension (generated ts/js/css/json artefacts). */
export async function formatFile(
  rel: string,
  source: string,
  options: Options = DEFAULT_PRETTIER_OPTIONS
) {
  if (/\.(ts|tsx|mts|cts)$/.test(rel)) return formatTs(source, options);
  if (/\.(js|jsx|mjs|cjs)$/.test(rel))
    return format(source, { ...options, parser: "babel", plugins: [estree, babel] });
  if (/\.css$/.test(rel)) return formatCss(source, options);
  if (/\.mdx?$/.test(rel))
    return format(source, { ...options, parser: "markdown", plugins: [markdown] });
  // prettier itself formats package.json with `json-stringify` (arrays expanded, like bun).
  if (/(^|\/)package\.json$/.test(rel))
    return format(source, { ...options, parser: "json-stringify", plugins: [estree, babel] });
  if (/\.json$/.test(rel)) return formatJson(source, options);
  return source;
}
