/**
 * bun run gen:privacy [--owner "<legal entity>"] [--date YYYY-MM-DD] [--stdout] [--root <dir>]
 *
 * readynative.config.ts + .readynative.json (the selected modules' privacy
 * declarations) → docs/privacy-policy.md, a privacy-policy draft that matches
 * what this build actually ships. Re-run after `bun run setup` changes a module.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { flagBool, parseArgs, resolveRoot } from "./lib/args.ts";
import {
  loadStateForPrivacy,
  renderPrivacyPolicy,
  writePrivacyPolicy,
  type PrivacyConfigInput,
} from "./lib/gen-privacy.ts";

const USAGE = `Usage: bun run gen:privacy [--owner "<legal entity>"] [--date YYYY-MM-DD] [--stdout] [--root <dir>]

  --owner   legal entity named in "Who we are" (default: a placeholder to fill in)
  --date    "Last updated" date (default: today)
  --stdout  print instead of writing docs/privacy-policy.md
  --root    project root (default: cwd)
`;

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["stdout", "help"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(flags);
  const configPath = path.join(root, "readynative.config.ts");
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: PrivacyConfigInput };
  if (!mod.default?.app?.name) throw new Error(`${configPath} must default-export app.name`);

  const owner = typeof flags.owner === "string" ? flags.owner : undefined;
  const date = typeof flags.date === "string" ? flags.date : undefined;
  const markdown = renderPrivacyPolicy(mod.default, loadStateForPrivacy(root), { owner, date });
  if (flagBool(flags, "stdout")) {
    process.stdout.write(markdown);
    return;
  }
  console.log(`wrote     ${writePrivacyPolicy(root, markdown)}`);
  console.log("Review it with a lawyer and fill in the placeholders before you publish it.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
