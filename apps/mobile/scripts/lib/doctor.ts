/**
 * Post-setup health checks: env keys, placeholders in readynative.config.ts,
 * EAS login, native toolchains (when a dev build is required), runtimes.
 * Side effects (commands, env, config loading) are injected so tests can fake them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readReadyNativeJson, type ReadyNativeState } from "./readynative-state.ts";
import { checkGraph, GRAPH_JSON } from "./graph.ts";
import { describePm, detectPm } from "./pm.ts";

/** `warn` is advisory: it prints, it does not make `doctor` exit 1. */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheckResult {
  label: string;
  status: CheckStatus;
  detail?: string;
  /**
   * A "before you ship" item: store / release identity (bundle id, urls, store ids, EAS
   * link, app icon). Placeholders are expected on day one, so they warn - `doctor --store`
   * (`strict`) turns them into failures, because by then they block a submission.
   */
  ship?: boolean;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
}

export interface DoctorDeps {
  root: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Run a command; `ok` = exit 0. */
  exec?: (cmd: string, args: string[]) => ExecResult;
  /** Load `readynative.config.ts` default export; undefined when it cannot be loaded. */
  loadConfig?: (root: string) => Promise<unknown>;
  /** Resolve `app.config.ts` the way Expo does; undefined when it cannot be loaded. */
  loadAppConfig?: (root: string) => Promise<unknown>;
  /** Override `.readynative.json` (tests). */
  state?: ReadyNativeState;
  /** `doctor --store`: "before you ship" items fail instead of warn. */
  strict?: boolean;
  /** sha256s `iconCheck` treats as the placeholder (tests). */
  placeholderIcons?: readonly string[];
}

export const PLACEHOLDER_ID = "com.acme.app";
export const PLACEHOLDER_NAME = "ReadyNative";

interface ConfigShape {
  app?: {
    name?: string;
    easProjectId?: string;
    ios?: { bundleId?: string };
    android?: { package?: string };
  };
  urls?: Record<string, string>;
  store?: Record<string, string>;
  links?: { domain?: string; appleTeamId?: string; androidCertFingerprints?: string[] };
}

/** A "before you ship" result: `warn` normally, `fail` under `doctor --store`. */
function shipCheck(label: string, ok: boolean, detail: string, strict: boolean): DoctorCheckResult {
  return ok
    ? { label, status: "ok", detail }
    : { label, status: strict ? "fail" : "warn", detail, ship: true };
}

/**
 * Pure: placeholder values a buyer must replace in readynative.config.ts before a store
 * build. They are "before you ship" items (see `DoctorCheckResult.ship`); a universal-links
 * domain that is set but incomplete is a real misconfiguration and always fails.
 */
export function placeholderChecks(config: unknown, strict = false): DoctorCheckResult[] {
  const c = (config ?? {}) as ConfigShape;
  const out: DoctorCheckResult[] = [];
  const bundleId = c.app?.ios?.bundleId ?? "";
  const pkg = c.app?.android?.package ?? "";
  const name = c.app?.name ?? "";
  const set = (value: string, placeholder: string) => Boolean(value) && value !== placeholder;

  out.push(
    shipCheck(
      "readynative.config.ts app.ios.bundleId set",
      set(bundleId, PLACEHOLDER_ID),
      set(bundleId, PLACEHOLDER_ID)
        ? bundleId
        : `still "${bundleId}" - set your own reverse-DNS id`,
      strict
    )
  );
  out.push(
    shipCheck(
      "readynative.config.ts app.android.package set",
      set(pkg, PLACEHOLDER_ID),
      set(pkg, PLACEHOLDER_ID) ? pkg : `still "${pkg}" - set your own reverse-DNS id`,
      strict
    )
  );
  out.push(
    shipCheck(
      "readynative.config.ts app.name set",
      set(name, PLACEHOLDER_NAME),
      set(name, PLACEHOLDER_NAME) ? name : `still "${name}"`,
      strict
    )
  );

  for (const [key, value] of Object.entries(c.urls ?? {})) {
    const empty = !value || value === "mailto:";
    out.push(
      shipCheck(`readynative.config.ts urls.${key}`, !empty, empty ? "empty" : value, strict)
    );
  }
  for (const [key, value] of Object.entries(c.store ?? {})) {
    out.push(
      shipCheck(`readynative.config.ts store.${key}`, Boolean(value), value || "empty", strict)
    );
  }

  // Universal links are opt-in: an empty domain is fine, a set domain needs both credentials.
  const domain = c.links?.domain?.trim() ?? "";
  if (!domain) {
    out.push({
      label: "readynative.config.ts links.domain",
      status: "skip",
      detail: "empty - universal links off",
    });
  } else {
    out.push({ label: "readynative.config.ts links.domain", status: "ok", detail: domain });
    const teamId = c.links?.appleTeamId?.trim() ?? "";
    out.push({
      label: "readynative.config.ts links.appleTeamId",
      status: teamId ? "ok" : "fail",
      detail: teamId || "empty - needed for apple-app-site-association",
    });
    const fingerprints = (c.links?.androidCertFingerprints ?? []).filter((f) => f.trim());
    out.push({
      label: "readynative.config.ts links.androidCertFingerprints",
      status: fingerprints.length ? "ok" : "fail",
      detail: fingerprints.length
        ? `${fingerprints.length} fingerprint(s)`
        : "empty - run `eas credentials` and paste the SHA-256 fingerprints",
    });
  }
  return out;
}

/**
 * Pure: EAS linking. `npx eas-cli init` cannot write into a dynamic `app.config.ts`, it only
 * prints the id - so the id lives in `readynative.config.ts` (or `EAS_PROJECT_ID` in CI) and
 * `app.config.ts` derives `extra.eas.projectId` and `updates.url` from it. `appConfig` is the
 * resolved `app.config.ts` (undefined when it could not be loaded → updates check skipped).
 */
export function easLinkChecks(
  config: unknown,
  env: NodeJS.ProcessEnv,
  appConfig: unknown,
  strict = false
): DoctorCheckResult[] {
  const projectId = (env.EAS_PROJECT_ID || (config as ConfigShape)?.app?.easProjectId || "").trim();
  if (!projectId) {
    // Not needed to develop (Expo Go, `expo run:*`); needed for EAS builds, updates, push.
    return [
      shipCheck(
        "EAS project linked",
        false,
        "not linked yet - run `npx eas-cli init`, paste the id into readynative.config.ts app.easProjectId (or set EAS_PROJECT_ID)",
        strict
      ),
    ];
  }
  const out: DoctorCheckResult[] = [
    { label: "EAS project linked", status: "ok", detail: projectId },
  ];
  if (appConfig === undefined) {
    out.push({
      label: "app.config.ts updates.url",
      status: "skip",
      detail: "app.config.ts not loaded",
    });
    return out;
  }
  const url = (appConfig as { updates?: { url?: string } }).updates?.url?.trim() ?? "";
  out.push({
    label: "app.config.ts updates.url",
    status: url ? "ok" : "fail",
    detail: url || "missing - run `npx eas-cli update:configure`",
  });
  return out;
}

/** Parse a dotenv file (KEY=value, `#` comments, optional quotes). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseSemver(text: string): [number, number, number] | undefined {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function atLeast(actual: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > min[i]) return true;
    if (actual[i] < min[i]) return false;
  }
  return true;
}

/**
 * `engines.node` of the tree: node strips TypeScript types natively from 22.18 on, and every
 * `scripts/*.ts` runs under plain node (scripts/check-node.cjs says the same before setup/doctor).
 */
export const MIN_NODE: [number, number, number] = [22, 18, 0];
/** The tree ships the text `bun.lock`, which bun reads from 1.2 on (1.1 only knew `bun.lockb`). */
export const MIN_BUN: [number, number, number] = [1, 2, 0];

/** The app icon `app.config.ts` ships, and the brand source `gen:assets` derives it from. */
export const ICON_PATHS = ["assets/images/icon.png", "assets/brand/icon.png"] as const;

/**
 * sha256 of the placeholder icons the template ships (`ICON_PATHS`, same order). Update
 * both when the placeholder artwork changes - a doctor test compares them with the files.
 */
export const PLACEHOLDER_ICON_SHA256: readonly string[] = [
  "a286adfe3953ae1a711d8474bc8481f841b23f3c29b3144b99a75aa61e8ef682",
  "b08ab8ad09034772fa14511f8240d2ee25e7f600d2d3f2f0e695ce621479184c",
];

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The placeholder app icon is still in place (either the generated icon or its brand
 * source). A "before you ship" item; skipped when the tree has no icon at all.
 */
export function iconCheck(
  root: string,
  strict = false,
  placeholders: readonly string[] = PLACEHOLDER_ICON_SHA256
): DoctorCheckResult {
  const label = "app icon replaced";
  const present = ICON_PATHS.filter((rel) => fs.existsSync(path.join(root, rel)));
  if (!present.length) return { label, status: "skip", detail: "no assets/images/icon.png" };
  const placeholder = present.find((rel) => placeholders.includes(sha256(path.join(root, rel))));
  return shipCheck(
    label,
    !placeholder,
    placeholder
      ? `${placeholder} is the ReadyNative placeholder - drop your 1024px PNG at assets/brand/icon.png and run \`gen:assets\``
      : "custom icon",
    strict
  );
}

/**
 * Why a key is missing and where to get it: the vendor dashboard page (`env[].docsUrl`)
 * and our own setup walkthrough (`guide`). Either part is dropped when the module does
 * not carry it, so a keyless module still reads as a sentence.
 */
export function missingEnvDetail(docsUrl?: string, guide?: string): string {
  const parts = ["missing in .env"];
  if (docsUrl) parts.push(`dashboard: ${docsUrl}`);
  if (guide) parts.push(`guide: ${guide}`);
  return parts.join(" · ");
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheckResult[]> {
  const { root } = deps;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const strict = deps.strict ?? false;
  const results: DoctorCheckResult[] = [];

  const state = deps.state ?? readReadyNativeJson(root);
  if (!state) {
    results.push({
      label: ".readynative.json present",
      status: "fail",
      detail: "run `bun run setup` (or `npm run setup`) first",
    });
  } else {
    results.push({
      label: ".readynative.json present",
      status: "ok",
      detail: `preset ${state.preset ?? "custom"}`,
    });
  }

  // Env keys from module doctor checks (.env file + process env).
  const dotenvPath = path.join(root, ".env");
  const dotenv = fs.existsSync(dotenvPath) ? parseDotenv(fs.readFileSync(dotenvPath, "utf8")) : {};
  for (const check of state?.modules.doctor ?? []) {
    if (check.type !== "env") continue;
    for (const key of check.keys) {
      const value = dotenv[key] || env[key];
      results.push({
        label: `${key} (${check.module})`,
        status: value ? "ok" : "fail",
        detail: value ? "set" : missingEnvDetail(check.docsUrls?.[key], check.guide),
      });
    }
  }

  // Placeholders in readynative.config.ts
  const configPath = path.join(root, "readynative.config.ts");
  if (!fs.existsSync(configPath)) {
    results.push({ label: "readynative.config.ts present", status: "fail", detail: "missing" });
  } else {
    let config: unknown;
    try {
      config = deps.loadConfig ? await deps.loadConfig(root) : await defaultLoadConfig(root);
    } catch (e) {
      results.push({
        label: "readynative.config.ts loads",
        status: "fail",
        detail: (e as Error).message,
      });
    }
    if (config !== undefined) results.push(...placeholderChecks(config, strict));

    // EAS linking: project id + the updates.url app.config.ts derives from it.
    let appConfig: unknown;
    if (deps.loadAppConfig || fs.existsSync(path.join(root, "app.config.ts"))) {
      try {
        appConfig = deps.loadAppConfig
          ? await deps.loadAppConfig(root)
          : await defaultLoadAppConfig(root);
      } catch (e) {
        results.push({
          label: "app.config.ts loads",
          status: "fail",
          detail: (e as Error).message,
        });
      }
    }
    results.push(...easLinkChecks(config, env, appConfig, strict));
  }
  results.push(iconCheck(root, strict, deps.placeholderIcons));

  // EAS login (skip when eas-cli is absent).
  const easPresent = exec("eas", ["--version"]).ok;
  let easLoggedIn = false;
  if (!easPresent) {
    results.push({ label: "eas whoami", status: "skip", detail: "eas-cli not installed" });
  } else {
    const who = exec("eas", ["whoami"]);
    easLoggedIn = who.ok;
    results.push(
      shipCheck(
        "eas whoami",
        who.ok,
        who.ok
          ? who.stdout.trim().split("\n")[0]
          : "not logged in (`eas login`) - needed for EAS builds",
        strict
      )
    );
  }

  // Native toolchains when a dev build is required. A signed-in EAS account is enough on its
  // own: `eas build --profile development` compiles in the cloud, so no local Xcode or Android
  // SDK is needed - a Windows/Linux buyer must not see a red X here.
  const needsDevBuild = (state?.modules.doctor ?? []).some((c) => c.type === "devBuild");
  if (needsDevBuild) {
    const xcode = platform === "darwin" ? exec("xcode-select", ["-p"]) : undefined;
    const androidHome = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
    const xcodeOk = xcode?.ok ?? false;
    const androidOk = Boolean(androidHome && fs.existsSync(androidHome));
    const cloud = easLoggedIn && !xcodeOk && !androidOk;
    results.push({
      label: "Xcode (dev build)",
      status:
        platform !== "darwin" ? "skip" : xcodeOk ? "ok" : androidOk || cloud ? "skip" : "fail",
      detail:
        platform !== "darwin"
          ? "not macOS"
          : xcodeOk
            ? xcode!.stdout.trim()
            : cloud
              ? "not installed - dev builds run on EAS (`eas build --profile development`)"
              : "xcode-select -p failed",
    });
    results.push({
      label: "Android SDK (dev build)",
      status: androidOk ? "ok" : xcodeOk || cloud ? "skip" : "fail",
      detail: androidOk
        ? androidHome
        : cloud
          ? "not installed - dev builds run on EAS (`eas build --profile development`)"
          : "ANDROID_HOME not set",
    });
  }

  // Runtimes. bun is required only for a bun tree; with another package manager the
  // scripts run on node (22.18+), so a missing or old bun is advisory there.
  const bun = exec("bun", ["--version"]);
  const bunVersion = parseSemver(bun.stdout);
  const treePm = detectPm(root, { env, hasBun: () => bun.ok });
  const bunOk = Boolean(bun.ok && bunVersion && atLeast(bunVersion, MIN_BUN));
  const bunNeeded = treePm.name === "bun";
  results.push({
    label: `bun >= ${MIN_BUN.join(".")}`,
    status: bunOk ? "ok" : bunNeeded ? "fail" : "warn",
    detail:
      (bun.ok ? bun.stdout.trim() : "bun not found") +
      (bunOk || bunNeeded ? "" : ` - optional with ${treePm.name}, recommended for speed`),
  });
  const node = exec("node", ["--version"]);
  const nodeVersion = parseSemver(node.stdout);
  // Below 22.18 node cannot run `scripts/*.ts` (no native type stripping) - with any pm.
  const nodeOk = Boolean(node.ok && nodeVersion && atLeast(nodeVersion, MIN_NODE));
  results.push({
    label: `node >= ${MIN_NODE.join(".")}`,
    status: nodeOk ? "ok" : "fail",
    detail: !node.ok
      ? "node not found"
      : nodeOk
        ? node.stdout.trim()
        : `${node.stdout.trim()} - Node ${MIN_NODE.slice(0, 2).join(".")}+ runs scripts/*.ts (24 LTS recommended)`,
  });

  // Which package manager this tree belongs to (`--pm`, the pm that launched us, the
  // `packageManager` field, the lockfile, then bun) - never a failure, only the answer.
  results.push({ label: "package manager", status: "ok", detail: describePm(treePm) });

  // docs/graph.json + ARCHITECTURE.md describe the tree; advisory when they lag behind
  // src/ (an agent added a route and forgot `gen:graph`). Only once the graph exists.
  if (fs.existsSync(path.join(root, GRAPH_JSON))) {
    const drift = await checkGraph(root);
    results.push({
      label: "architecture graph",
      status: drift.length ? "warn" : "ok",
      detail: drift.length
        ? `stale (${drift.join(", ")}) - run \`bun run gen:graph\``
        : "docs/graph.json matches src/",
    });
  }

  return results;
}

export function defaultExec(cmd: string, args: string[]): ExecResult {
  // `eas`, `npm`, … are `.cmd` shims on Windows, which spawn only through a shell. A
  // command that cannot start at all (`r.error`, ENOENT) is simply not ok.
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
  });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "" };
}

/** `readynative.config.ts` default export. Shared with lib/store-check.ts. */
export async function defaultLoadConfig(root: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path.join(root, "readynative.config.ts")).href)) as {
    default?: unknown;
  };
  return mod.default ?? mod;
}

/** Evaluate `app.config.ts` the way Expo does: default export called with an empty base config. */
export async function defaultLoadAppConfig(root: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path.join(root, "app.config.ts")).href)) as {
    default?: unknown;
  };
  const fn = mod.default;
  return typeof fn === "function"
    ? (fn as (ctx: { config: Record<string, unknown> }) => unknown)({ config: {} })
    : fn;
}

/**
 * The checklist, "before you ship" items grouped at the end under their own heading so a
 * fresh clone reads as "all good, and here is what to do before the store".
 */
export function formatChecklist(results: DoctorCheckResult[]): string {
  const icon = { ok: "✓", warn: "!", fail: "✗", skip: "-" } as const;
  const line = (r: DoctorCheckResult) =>
    `${icon[r.status]} ${r.label}${r.detail ? `  (${r.detail})` : ""}`;
  const now = results.filter((r) => !r.ship).map(line);
  const ship = results.filter((r) => r.ship).map(line);
  return ship.length ? [...now, "", "Before you ship:", ...ship].join("\n") : now.join("\n");
}
