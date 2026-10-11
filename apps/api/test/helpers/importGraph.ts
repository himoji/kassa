/*
 * Runtime import graph of apps/api/src (I1 import-graph test, spec §19). Follows every relative static import,
 * re-export and literal dynamic import(); `import type` / `export type` are skipped (erased at runtime).
 * Package imports (@kassa/shared, drizzle-orm, …) are leaves.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.[cm]?[jt]sx?$/.test(f) ? [p] : [];
  });
}

/** Runtime (non type-only) relative import specifiers of one file. */
export function runtimeImports(file: string): string[] {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  // import x from "…" / import { a, type B } from "…" / import "…" / export … from "…"
  for (const m of src.matchAll(/(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (m[2]) continue; // import type / export type
    out.push(m[4]!);
  }
  for (const m of src.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out.filter((s) => s.startsWith("."));
}

function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

export type Graph = Map<string, { importedBy: string | null; imports: string[] }>;

/** Breadth-first closure from `roots`; each node records the first module that reached it (for a path). */
export function closure(roots: string[]): Graph {
  const g: Graph = new Map();
  const queue = [...roots];
  for (const r of roots) g.set(r, { importedBy: null, imports: [] });
  while (queue.length > 0) {
    const f = queue.shift()!;
    for (const spec of runtimeImports(f)) {
      const to = resolveSpec(f, spec);
      if (!to) throw new Error(`unresolved import ${spec} in ${relative(API_ROOT, f)}`);
      g.get(f)!.imports.push(to);
      if (!g.has(to)) {
        g.set(to, { importedBy: f, imports: [] });
        queue.push(to);
      }
    }
  }
  return g;
}

/** "a.ts → b.ts → c.ts" from a root to `file`. */
export function pathTo(g: Graph, file: string): string {
  const chain: string[] = [];
  for (let c: string | null = file; c; c = g.get(c)?.importedBy ?? null) chain.unshift(relative(API_ROOT, c));
  return chain.join(" → ");
}
