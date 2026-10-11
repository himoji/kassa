/* Minimal argv parser: positionals plus `--flag`, `--key value` and `--key=value`. */

export type Args = { _: string[]; flags: Record<string, string | true> };

/**
 * Flags that never take a value (so `--sign <next positional>` is not swallowed). `--claim-demo` is not one:
 * it optionally names a seeded persona (`register li --claim-demo li-wei`); bare `--claim-demo` = the hero.
 */
const BOOLEAN_FLAGS = new Set(["fresh", "sign", "no-onboard", "no-mandate", "no-ai-consent", "force", "scheduler", "withdraw", "live-fx"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
        out.flags[name] = next;
        i++;
      } else out.flags[name] = true;
      continue;
    }
    out._.push(a);
  }
  return out;
}

export function flagStr(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags[name] !== undefined && args.flags[name] !== "false";
}
