/**
 * Which package manager the buyer uses.
 *
 * bun is the recommendation and what the docs show first, but nothing in the tree
 * requires it: `setup`, `doctor`, the buyer CI and the install steps all go through the
 * `Pm` this module resolves. Detection is deliberately boring - the flag the buyer
 * passed, then the pm that launched us, then what the tree already says, then what is
 * installed - so the same answer comes out of `setup`, `finalize` and `doctor`.
 *
 * Like `readynative-state.ts` this file has no module-system imports: it survives finalize
 * (`doctor` reads it) and ships to buyers as `scripts/lib/pm.ts`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type PmName = "bun" | "pnpm" | "yarn" | "npm";

export const PM_NAMES: readonly PmName[] = ["bun", "pnpm", "yarn", "npm"];

export function isPmName(value: string): value is PmName {
  return (PM_NAMES as readonly string[]).includes(value);
}

export interface Pm {
  name: PmName;
  /** The lockfile this pm writes (the first one of `LOCKFILES`). */
  lockfile: string;
  /** Full argv of a plain install. */
  install: string[];
  /** Full argv of a lockfile-respecting install (CI). */
  frozenInstall: string[];
  /** Full argv of `<pm> run <script> [args]`. */
  run: (script: string, args?: string[]) => string[];
  /** Full argv that runs a binary from `node_modules/.bin` (`expo`, `eas-cli`, …). */
  exec: (bin: string, args?: string[]) => string[];
}

/**
 * Lockfiles per pm, most specific first. bun writes `bun.lock` since 1.2 and `bun.lockb`
 * before that; both mean "this tree is a bun tree".
 */
export const LOCKFILES: Record<PmName, string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  npm: ["package-lock.json"],
};

/**
 * `exec` runs a binary the project depends on, so it must not reach out to a registry:
 *   - bun:  `bunx` prefers the local `node_modules/.bin` and only then downloads;
 *   - pnpm: `pnpm exec` is local-only by definition (`pnpm dlx` is the downloading one);
 *   - yarn: `yarn run <bin>` rather than `yarn exec` - `exec` is Berry-only, while
 *           `run` resolves `node_modules/.bin` on both Yarn 1 and Berry;
 *   - npm:  `npx --no-install` fails loudly instead of silently fetching a package.
 */
const PMS: Record<PmName, Pm> = {
  bun: {
    name: "bun",
    lockfile: LOCKFILES.bun[0],
    install: ["bun", "install"],
    frozenInstall: ["bun", "install", "--frozen-lockfile"],
    run: (script, args = []) => ["bun", "run", script, ...args],
    exec: (bin, args = []) => ["bunx", bin, ...args],
  },
  pnpm: {
    name: "pnpm",
    lockfile: LOCKFILES.pnpm[0],
    install: ["pnpm", "install"],
    frozenInstall: ["pnpm", "install", "--frozen-lockfile"],
    run: (script, args = []) => ["pnpm", "run", script, ...args],
    exec: (bin, args = []) => ["pnpm", "exec", bin, ...args],
  },
  yarn: {
    name: "yarn",
    lockfile: LOCKFILES.yarn[0],
    install: ["yarn", "install"],
    frozenInstall: ["yarn", "install", "--immutable"],
    run: (script, args = []) => ["yarn", "run", script, ...args],
    exec: (bin, args = []) => ["yarn", "run", bin, ...args],
  },
  npm: {
    name: "npm",
    lockfile: LOCKFILES.npm[0],
    install: ["npm", "install"],
    frozenInstall: ["npm", "ci"],
    // npm swallows flags meant for the script unless they come after `--`.
    run: (script, args = []) => ["npm", "run", script, ...(args.length ? ["--", ...args] : [])],
    exec: (bin, args = []) => ["npx", "--no-install", bin, ...args],
  },
};

export function pm(name: PmName): Pm {
  return PMS[name];
}

/** `bun (bun.lock)` - what `setup` and `doctor` print. */
export function describePm(p: Pm): string {
  return `${p.name} (${p.lockfile})`;
}

/** The lockfiles of every *other* pm: what a finalized tree must not keep around. */
export function otherLockfiles(name: PmName): string[] {
  return PM_NAMES.filter((n) => n !== name).flatMap((n) => LOCKFILES[n]);
}

export class PmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PmError";
  }
}

export interface DetectPmOptions {
  /** `--pm <name>`; anything but a known name is an error, not a fallback. */
  override?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests fake this; the default asks bun itself. */
  hasBun?: () => boolean;
}

/** `npm_config_user_agent` is `"<pm>/<version> npm/? node/… "` - the pm that launched us. */
function fromUserAgent(env: NodeJS.ProcessEnv): PmName | undefined {
  const agent = env.npm_config_user_agent ?? "";
  return PM_NAMES.find((name) => agent.startsWith(`${name}/`));
}

/** `"packageManager": "pnpm@9.1.0"` (corepack) - the tree's own declaration. */
function fromPackageJson(root: string): PmName | undefined {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return undefined;
  let field: unknown;
  try {
    field = (JSON.parse(fs.readFileSync(file, "utf8")) as { packageManager?: unknown })
      .packageManager;
  } catch {
    return undefined; // a broken package.json is somebody else's error to report
  }
  if (typeof field !== "string") return undefined;
  const name = field.split("@")[0].trim();
  return isPmName(name) ? name : undefined;
}

function fromLockfile(root: string): PmName | undefined {
  return PM_NAMES.find((name) =>
    LOCKFILES[name].some((lock) => fs.existsSync(path.join(root, lock)))
  );
}

function bunOnPath(): boolean {
  const r = spawnSync("bun", ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return !r.error && r.status === 0;
}

export function detectPm(root: string, opts: DetectPmOptions = {}): Pm {
  const { override, env = process.env, hasBun = bunOnPath } = opts;
  if (override !== undefined) {
    if (!isPmName(override)) {
      throw new PmError(`Unknown package manager "${override}" (expected ${PM_NAMES.join(" | ")})`);
    }
    return PMS[override];
  }
  const detected = fromUserAgent(env) ?? fromPackageJson(root) ?? fromLockfile(root);
  if (detected) return PMS[detected];
  return PMS[hasBun() ? "bun" : "npm"];
}

// ---------------------------------------------------------------------------
// CI template
// ---------------------------------------------------------------------------

/**
 * The bun CI installs with: the version that resolved the `bun.lock` the tree shipped with,
 * so `bun install --frozen-lockfile` reads it exactly as it was written. Bump it together
 * with the product's own toolchain (`packageManager` of the ReadyNative repo).
 */
export const CI_BUN_VERSION = "1.4.0";

/**
 * The `{{PM_SETUP}}` block of a GitHub workflow, indented for `jobs.<job>.steps`.
 * bun needs no Node step (it is the runtime); the others pin Node 24 LTS and let
 * `actions/setup-node` cache the pm's store.
 */
const CI_SETUP: Record<PmName, string> = {
  bun: `      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${CI_BUN_VERSION}`,
  pnpm: `      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm`,
  yarn: `      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: yarn`,
  npm: `      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm`,
};

/** `{{PM_RUN}} test --ci` - the rest of the line is the script plus its arguments. */
const PM_RUN_LINE = /\{\{PM_RUN\}\}([^\n]*)/g;

/**
 * Renders `{{PM_SETUP}}` / `{{PM_INSTALL}}` / `{{PM_RUN}}` for `p`. Deliberately not
 * `${{ }}`: GitHub expressions use that syntax and must survive untouched.
 *
 * `{{PM_RUN}}` swallows the rest of its line so the arguments can be routed through
 * `Pm.run` - `npm run test --ci` would hand `--ci` to npm, not to jest.
 */
export function renderCiTemplate(template: string, p: Pm): string {
  return template
    .replace(/^[ \t]*\{\{PM_SETUP\}\}[ \t]*$/gm, CI_SETUP[p.name])
    .replace(/\{\{PM_INSTALL\}\}/g, p.frozenInstall.join(" "))
    .replace(PM_RUN_LINE, (_m, rest: string) => {
      const [script, ...args] = rest.trim().split(/\s+/).filter(Boolean);
      if (!script) return p.run("x").slice(0, -1).join(" "); // bare prefix
      return p.run(script, args).join(" ");
    });
}

// ---------------------------------------------------------------------------
// EAS workflow
// ---------------------------------------------------------------------------

/** One `- if: <cond>` + `uses: oven-sh/setup-bun` step (and its `with:` block). */
const EAS_BUN_SETUP =
  /^([ \t]*)- if: ([^\n]+)\n[ \t]+uses: oven-sh\/setup-bun@[^\n]*\n(?:[ \t]+with:\n(?:[ \t]{2,}[\w-]+:[^\n]*\n)+)?/gm;

/**
 * `.github/workflows/eas-preview.yml` for `p`. The workflow is not a `{{PM_*}}` template (the
 * monorepo runs the same file), so the bun lines are rewritten in place: every
 * `setup-bun` step becomes the pm's `CI_SETUP` steps carrying the same `if:` guard,
 * `packager: bun` (expo/expo-github-action) names the pm, and `bun install
 * --frozen-lockfile` becomes the pm's frozen install. Identity for bun.
 */
export function renderEasWorkflow(yaml: string, p: Pm): string {
  if (p.name === "bun") return yaml;
  return yaml
    .replace(EAS_BUN_SETUP, (_m, indent: string, cond: string) =>
      CI_SETUP[p.name]
        .split("\n")
        .map((line) => line.replace(/^[ \t]*- uses:/, `${indent}- if: ${cond}\n${indent}  uses:`))
        .join("\n")
        .concat("\n")
    )
    .replace(/^([ \t]*packager:[ \t]*)bun[ \t]*$/gm, `$1${p.name}`)
    .replace(/bun install --frozen-lockfile/g, p.frozenInstall.join(" "));
}
