import path from "node:path";

/** Minimal `--key value` / `--flag` / `--no-flag` parser; no dependency needed. */
export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[], booleans: string[] = []): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (name.startsWith("no-") && !booleans.includes(name)) {
      flags[name.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { flags, positional };
}

export function flagString(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string, fallback = false) {
  const v = flags[name];
  return typeof v === "boolean" ? v : fallback;
}

export function resolveRoot(flags: Record<string, string | boolean>): string {
  const root = flagString(flags, "root");
  return root ? path.resolve(root) : process.cwd();
}
