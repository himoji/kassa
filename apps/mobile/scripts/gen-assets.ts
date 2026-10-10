/**
 * bun run gen:assets  →  node scripts/gen-assets.ts [--source <png>] [--root <dir>]
 *
 * Regenerates assets/images/{icon,android-icon-*,splash-icon,favicon}.png from
 * assets/brand/icon.png using brand.primary from readynative.config.ts.
 *
 * Runs under Node, not bun: sharp 0.35 hangs inside bun 1.4 (any libvips call
 * never resolves), while Node ≥22.18 strips the types natively. That is why the
 * imports below carry explicit `.ts` extensions (Node does no extension probing).
 */
import { flagString, parseArgs, resolveRoot } from "./lib/args.ts";
import { generateAssets, loadReadyNativeConfig } from "./lib/gen-assets.ts";

const USAGE = `Usage: bun run gen:assets [--source <png>] [--root <dir>]

  --source  square PNG (≥1024px) to derive every icon from; default assets/brand/icon.png
  --root    project root; default cwd
`;

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["help"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(flags);
  const config = await loadReadyNativeConfig(root);
  const { written, warnings } = await generateAssets({
    root,
    source: flagString(flags, "source"),
    config,
  });
  for (const w of warnings) console.warn(`! ${w}`);
  for (const file of written) console.log(`✓ ${file.slice(root.length + 1)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
