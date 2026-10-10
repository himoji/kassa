/**
 * bun run test:e2e [--variant dev|preview|prod] [--dry-run] [--root <dir>] [maestro args]
 *
 * Runs the Maestro flows in `.maestro/flows` against the ids from `readynative.config.ts`, so a
 * rebrand does not break e2e: `APP_ID` / `APP_NAME` are passed as `-e` variables.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveRoot } from "./lib/args.ts";
import {
  cmdLine,
  e2eEnv,
  formatCommand,
  maestroArgs,
  parseE2eArgs,
  VARIANTS,
  type E2eConfigInput,
} from "./lib/e2e.ts";

const USAGE = `Usage: bun run test:e2e [--variant <${VARIANTS.join("|")}>] [--dry-run] [--root <dir>] [maestro args]

  --variant   app variant whose ids to target (default: dev)
  --dry-run   print the maestro command instead of running it
  --root      project root (default: cwd)

Any other argument is forwarded to maestro; a flow path replaces the default .maestro/flows.
`;

async function main() {
  const args = parseE2eArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(args.root === undefined ? {} : { root: args.root });

  // Loaded from the root so `--root <fixture>` works; bun imports TS directly. A file URL,
  // not the path: `C:\…` is not an import specifier on Windows.
  const configPath = path.join(root, "readynative.config.ts");
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: E2eConfigInput };
  const config = mod.default;
  if (!config?.app?.name || !config.app.ios?.bundleId) {
    throw new Error(`${configPath} must default-export app.name and app.ios.bundleId`);
  }

  const argv = maestroArgs(e2eEnv(config, args.variant), args.extra);
  if (args.dryRun) {
    console.log(formatCommand(argv));
    return;
  }
  // Windows: maestro is a .bat, which only starts through cmd.exe - so hand it one line
  // with every argument quoted for cmd (lib/e2e.ts cmdLine), never raw args plus `shell`.
  const result =
    process.platform === "win32"
      ? spawnSync(cmdLine("maestro", argv), { cwd: root, stdio: "inherit", shell: true })
      : spawnSync("maestro", argv, { cwd: root, stdio: "inherit" });
  if (result.error) {
    throw new Error(
      `maestro could not start (${result.error.message}) - install it with: curl -Ls "https://get.maestro.mobile.dev" | bash`
    );
  }
  process.exit(result.status ?? 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
