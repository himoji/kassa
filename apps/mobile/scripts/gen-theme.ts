/**
 * bun gen:theme [--check] [--root <dir>]
 *
 * src/theme/tokens.ts → every ui stack's generated theme artefact under
 * modules/ui/<stack>/files/ (per its module.json `gen`) and, for the active ui
 * (or nativewind4 when setup has not run yet), the root copy:
 *   nativewind5 → src/global.css · nativewind4 → src/global.css + tailwind.config.js
 *   tamagui → tamagui.config.ts
 * `--check` exits 1 with a diff summary instead of writing.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { flagBool, parseArgs, resolveRoot } from "./lib/args.ts";
import {
  runGenTheme,
  themeExtraFromTokens,
  themeInputFromTokens,
  type TokensModule,
} from "./lib/gen-theme.ts";

const USAGE = `Usage: bun gen:theme [--check] [--root <dir>]

  --check   exit 1 if any generated theme file differs from src/theme/tokens.ts
  --root    project root (default: cwd)
`;

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["check", "help"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(flags);
  const check = flagBool(flags, "check");

  // Loaded from the root so `--root <fixture>` works; bun imports TS directly. A file URL,
  // not the path: `C:\…` is not an import specifier on Windows.
  const tokensPath = path.join(root, "src/theme/tokens.ts");
  const tokens = (await import(pathToFileURL(tokensPath).href)) as TokensModule;
  if (typeof tokens.cssColorVariables !== "function" || !tokens.radius) {
    throw new Error(`${tokensPath} must export cssColorVariables() and radius`);
  }

  const result = await runGenTheme({
    root,
    input: themeInputFromTokens(tokens),
    extra: themeExtraFromTokens(tokens),
    check,
  });
  for (const f of result.unchanged) console.log(`unchanged ${f}`);
  for (const f of result.written) console.log(`wrote     ${f}`);
  if (result.drift.length) {
    for (const d of result.drift) console.log(`DRIFT     ${d.file}\n${d.summary}`);
    console.log("\nRun `bun gen:theme` to regenerate.");
    process.exit(1);
  }
  if (result.unchanged.length + result.written.length === 0) {
    console.log("No gen-theme targets in this root (no modules/ui/* with gen targets).");
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
