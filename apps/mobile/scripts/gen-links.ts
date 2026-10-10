/**
 * bun gen:links [--check] [--root <dir>]
 *
 * readynative.config.ts (`links` + bundle ids) → public/.well-known/apple-app-site-association
 * and public/.well-known/assetlinks.json, the files `links.domain` must serve for universal
 * links / App Links. `--check` exits 1 with the drifted files instead of writing.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { flagBool, parseArgs, resolveRoot } from "./lib/args.ts";
import { checkLinks, writeLinks, type LinksConfigInput } from "./lib/gen-links.ts";

const USAGE = `Usage: bun gen:links [--check] [--root <dir>]

  --check   exit 1 if public/.well-known/* differs from readynative.config.ts
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
  const configPath = path.join(root, "readynative.config.ts");
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: LinksConfigInput };
  const config = mod.default;
  if (!config?.app?.ios?.bundleId || !config.app.android?.package || !config.links) {
    throw new Error(
      `${configPath} must default-export app.ios.bundleId, app.android.package, links`
    );
  }

  if (check) {
    const drift = await checkLinks(root, config);
    if (drift.length) {
      for (const d of drift) console.log(`DRIFT     ${d.file} (${d.reason})`);
      console.log("\nRun `bun gen:links` to regenerate.");
      process.exit(1);
    }
    console.log("public/.well-known up to date");
    return;
  }
  for (const f of await writeLinks(root, config)) console.log(`wrote     ${f}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
