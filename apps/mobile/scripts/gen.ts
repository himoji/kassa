/**
 * bun run scripts/gen.ts screen <name> [--tab [--icon <sf-symbol>] [--icon-fallback <material>] [--title <title>] | --modal] [--root <dir>]
 * bun run scripts/gen.ts module <category> <option> [--root <dir>]
 */
import fs from "node:fs";
import path from "node:path";

import { flagBool, flagString, parseArgs, resolveRoot } from "./lib/args.ts";
import {
  DEFAULT_TAB_ICON,
  DEFAULT_TAB_ICON_FALLBACK,
  genModule,
  genScreen,
  type GenScreenResult,
} from "./lib/scaffold.ts";

const USAGE = `Usage:
  bun run gen screen <name>                 → src/screens/<name>/<name>-screen.tsx + src/app/<name>.tsx
  bun run gen screen <name> --tab           → … + src/app/(tabs)/<name>.tsx, a <Tabs.Screen> entry and the en locale key
  bun run gen screen <name> --modal         → … + src/app/<name>/{_layout,index}.tsx (presentation: "modal") and a root <Stack.Screen> entry
  bun run gen module <category> <option>    → modules/<category>/<option>/{module.json,files/,docs.md}

  --tab                    add the screen as a tab (mutually exclusive with --modal)
  --icon <sf-symbol>       tab icon, SF Symbol name (default: ${DEFAULT_TAB_ICON})
  --icon-fallback <name>   Material symbol used on Android/web (default: ${DEFAULT_TAB_ICON_FALLBACK})
  --title "<Title>"        tab title (default: title-cased name)
  --modal                  present the screen modally (mutually exclusive with --tab)
  --root <dir>             project root (default: cwd)
`;

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), ["help", "tab", "modal"]);
  const [kind, ...rest] = positional;
  if (flags.help || !kind) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }
  const root = resolveRoot(flags);
  const tab = flagBool(flags, "tab");
  const modal = flagBool(flags, "modal");
  if (tab && modal) {
    console.error("--tab and --modal are mutually exclusive\n");
    console.error(USAGE);
    process.exit(1);
  }
  if (!tab && (flagString(flags, "icon") || flagString(flags, "icon-fallback"))) {
    console.error("--icon / --icon-fallback only apply to --tab\n");
    console.error(USAGE);
    process.exit(1);
  }

  let result: GenScreenResult;
  if (kind === "screen" && rest.length === 1) {
    result = genScreen(root, rest[0], {
      tab,
      modal,
      icon: flagString(flags, "icon"),
      iconFallback: flagString(flags, "icon-fallback"),
      title: flagString(flags, "title"),
    });
  } else if (kind === "module" && rest.length === 2) {
    // setup finalized this tree (modules/ is gone): a new module has nothing to plug into.
    if (!fs.existsSync(path.join(root, "modules"))) {
      console.error(
        "gen module needs the module system (modules/), which setup removed when it finalized this tree."
      );
      process.exit(1);
    }
    result = { created: genModule(root, rest[0], rest[1]), updated: [], warnings: [] };
  } else {
    console.error(USAGE);
    process.exit(1);
  }
  for (const f of result.created) console.log(`created ${f}`);
  for (const f of result.updated) console.log(`updated ${f}`);
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (tab && !flagString(flags, "icon-fallback")) {
    console.log(
      `note: Android/web tab icon falls back to "${DEFAULT_TAB_ICON_FALLBACK}" - pass --icon-fallback <material-symbol> to change it`
    );
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
