/**
 * `bun run test:e2e` command builder: readynative.config.ts → the `-e` variables the Maestro
 * flows in `.maestro/flows` read (`${APP_ID}`, `${APP_NAME}`).
 *
 * The variant suffixes must stay in sync with `variantMeta` in app.config.ts: the bundle id
 * gets `.dev` / `.preview` / nothing, the springboard name gets " (Dev)" / " (Preview)".
 * `APP_NAME` is the *unsuffixed* config name on purpose - flows assert text rendered inside
 * the app (`readynative.app.name`), not the home screen icon label, which is `APP_DISPLAY_NAME`.
 */
export type Variant = "dev" | "preview" | "prod";

/** Aliases accepted on the command line (EAS profile names) → app.config.ts variants. */
const VARIANT_ALIASES: Record<string, Variant> = {
  dev: "dev",
  development: "dev",
  preview: "preview",
  prod: "prod",
  production: "prod",
};

export const VARIANTS = Object.keys(VARIANT_ALIASES);

/** Must match `variantMeta` in app.config.ts. */
export const VARIANT_META: Record<Variant, { nameSuffix: string; idSuffix: string }> = {
  dev: { nameSuffix: " (Dev)", idSuffix: ".dev" },
  preview: { nameSuffix: " (Preview)", idSuffix: ".preview" },
  prod: { nameSuffix: "", idSuffix: "" },
};

/** The slice of `ReadyNativeConfig` the e2e runner reads (structural so fixtures stay small). */
export interface E2eConfigInput {
  app: { name: string; ios: { bundleId: string } };
}

export interface E2eEnv {
  APP_ID: string;
  APP_NAME: string;
  APP_DISPLAY_NAME: string;
}

export function parseVariant(value: string | undefined): Variant {
  if (value === undefined) return "dev";
  const variant = VARIANT_ALIASES[value];
  if (!variant) {
    throw new Error(`Unknown --variant "${value}" (expected one of: ${VARIANTS.join(", ")})`);
  }
  return variant;
}

/** readynative.config.ts + variant → the `-e` variables passed to maestro. */
export function e2eEnv(config: E2eConfigInput, variant: Variant = "dev"): E2eEnv {
  const { nameSuffix, idSuffix } = VARIANT_META[variant];
  return {
    APP_ID: `${config.app.ios.bundleId}${idSuffix}`,
    APP_NAME: config.app.name,
    APP_DISPLAY_NAME: `${config.app.name}${nameSuffix}`,
  };
}

/**
 * Full argv for `maestro`. `extra` is passed through (maestro flags such as `--format`); a
 * positional in `extra` (a single flow file) replaces the default `.maestro/flows` target.
 */
export function maestroArgs(env: E2eEnv, extra: string[] = [], flows = ".maestro/flows"): string[] {
  const vars = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const hasTarget = extra.some((a) => !a.startsWith("-"));
  return ["test", ...vars, ...extra, ...(hasTarget ? [] : [flows])];
}

/** Shell-ish rendering used by `--dry-run` (quotes only what needs it). */
export function formatCommand(args: string[]): string {
  return ["maestro", ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** Characters cmd.exe treats specially on a command line (cross-spawn's set). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a `cmd.exe /d /s /c "…"` line (what `spawn(…, { shell: true })` runs on
 * Windows): quoted the way the program's CommandLineToArgvW reads it back (backslashes
 * before a quote doubled, the quote escaped), then every cmd metacharacter `^`-escaped so
 * `&`, `|`, `%`, `(`, spaces… reach the program literally. Same algorithm as cross-spawn.
 */
export function quoteForCmd(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META, "^$1");
}

/**
 * The whole command line for a Windows shell spawn. `maestro` is a `.bat` there, which Node
 * only starts through cmd.exe, and a `-e "APP_DISPLAY_NAME=Acme (Dev)"` passed as a plain
 * arg would be split at the space and have its parentheses interpreted.
 */
export function cmdLine(cmd: string, args: string[]): string {
  return [cmd, ...args.map(quoteForCmd)].join(" ");
}

export interface E2eArgs {
  variant: Variant;
  dryRun: boolean;
  help: boolean;
  root?: string;
  /** Everything not consumed here, forwarded to maestro verbatim. */
  extra: string[];
}

/**
 * Splits our own flags out of argv instead of using `parseArgs`, so unknown maestro flags
 * (`--format junit`, `--debug-output …`) survive untouched.
 */
export function parseE2eArgs(argv: string[]): E2eArgs {
  const own = new Set(["--variant", "--root"]);
  let variant: string | undefined;
  let root: string | undefined;
  let dryRun = false;
  let help = false;
  const extra: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (own.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${name} needs a value`);
      if (name === "--variant") variant = value;
      else root = value;
      continue;
    }
    extra.push(arg);
  }
  return { variant: parseVariant(variant), dryRun, help, root, extra };
}
