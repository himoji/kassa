/**
 * bun gen:graph [--check] [--root <dir>]
 *
 * The tree → `docs/graph.json` + `docs/ARCHITECTURE.md` (mermaid map + one table per
 * kind). Nothing is hand-maintained: run it after adding a route, a lib shim, a
 * provider or an env key. `--check` exits 1 when the committed files are stale, which
 * is what the buyer CI runs.
 */
import { flagBool, parseArgs, resolveRoot } from "./lib/args.ts";
import { buildGraph, checkGraph, validateGraph, writeGraph } from "./lib/graph.ts";

const USAGE = `Usage: bun gen:graph [--check] [--root <dir>]

  --check   exit 1 if docs/graph.json or docs/ARCHITECTURE.md is out of date
  --root    project root (default: cwd)

Extend the graph without touching this script:
  docs/graph.extra.json          { "nodes": [...], "edges": [...] }, merged verbatim
  // @graph node=<id> kind=<kind> label="…" edges=<id>,<id>   in any src/** file
`;

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["check", "help"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(flags);

  for (const warning of validateGraph(buildGraph(root))) console.warn(`warning: ${warning}`);

  if (flagBool(flags, "check")) {
    const drift = await checkGraph(root);
    if (drift.length) {
      for (const rel of drift) console.log(`DRIFT     ${rel}`);
      console.log("\nRun `bun run gen:graph` to regenerate.");
      process.exit(1);
    }
    console.log("docs/graph.json up to date");
    return;
  }

  const written = await writeGraph(root);
  if (!written.length) console.log("unchanged  docs/graph.json, docs/ARCHITECTURE.md");
  for (const rel of written) console.log(`wrote     ${rel}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
