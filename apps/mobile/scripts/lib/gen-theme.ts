/**
 * tokens → generated theme artefacts for every ui stack that declares a `gen`
 * target in its module.json:
 *
 * - `nativewind5` → `src/global.css` (Tailwind 4 `@theme` + `:root` colour vars)
 * - `nativewind4` → `src/global.css` (HSL triples) + `tailwind.config.js`
 * - `tamagui`     → `tamagui.config.ts` (static themes + token scales)
 *
 * Each target is written under `modules/ui/<stack>/files/` (the module copy) and,
 * when that stack is the active ui per `.readynative.json`, at the root as well.
 * Output is prettier-formatted with the repo options.
 */
import fs from "node:fs";
import path from "node:path";

import { readReadyNativeJson } from "./readynative-state.ts";
import { formatFile, loadPrettierOptions } from "./format.ts";
import { renderNativewind4 } from "./gen-theme-nativewind4.ts"; // readynative:gen nativewind4

export interface ThemeInput {
  /** `--color-*` → value, kebab-case (from `cssColorVariables("light")`). */
  light: Record<string, string>;
  dark: Record<string, string>;
  radius: { sm: number; md: number; lg: number };
}

/**
 * Per-stack extras the shared `ThemeInput` does not carry, keyed by gen id
 * (`tamagui` → `TamaguiExtra`). Deliberately untyped: only the emitter of that
 * stack knows the shape, and it is the only file that survives `bun setup`.
 */
export interface ThemeExtra {
  [gen: string]: unknown;
}

/** Shape of `src/theme/tokens.ts` that gen-theme needs. */
export interface TokensModule {
  cssColorVariables: (mode: "light" | "dark") => Record<string, string>;
  radius: { sm: number; md: number; lg: number } & Record<string, number>;
  space?: Record<string, number>;
  colors?: { light: { brandAccent?: string }; dark: { brandAccent?: string } };
}

export function themeInputFromTokens(tokens: TokensModule): ThemeInput {
  return {
    light: tokens.cssColorVariables("light"),
    dark: tokens.cssColorVariables("dark"),
    radius: { sm: tokens.radius.sm, md: tokens.radius.md, lg: tokens.radius.lg },
  };
}

export function themeExtraFromTokens(tokens: TokensModule): ThemeExtra {
  const brand = (mode: "light" | "dark"): Record<string, string> => {
    const accent = tokens.colors?.[mode]?.brandAccent;
    return accent ? { brandAccent: accent } : {};
  };
  return {
    tamagui: {
      space: tokens.space,
      radius: tokens.radius,
      colors: { light: brand("light"), dark: brand("dark") },
    },
  };
}

/** gen id → module-relative artefacts (`modules/ui/<stack>/files/<root path>` → content). */
export type Renderer = (input: ThemeInput, extra: ThemeExtra) => Record<string, string>;

/**
 * One entry per ui stack that generates a theme artefact. `bun setup` (finalize)
 * keeps only the active stack's line and deletes the other emitters, so never put
 * anything but a single `<gen id>: <renderer>,` pair on an `readynative:gen` line.
 */
const RENDERERS: Record<string, Renderer> = {
  nativewind4: renderNativewind4, // readynative:gen nativewind4
};

const MODULES_UI_DIR = "modules/ui";

const MODULE_FILES_PREFIX = /^modules\/ui\/[^/]+\/files\//;

/** `modules/ui/x/files/src/global.css` → `src/global.css`. */
export function rootPathOf(moduleRel: string): string {
  return moduleRel.replace(MODULE_FILES_PREFIX, "");
}

export interface ThemeTarget {
  /** gen id (`nativewind5`, `nativewind4`, `tamagui`). */
  gen: string;
  /** Module-relative artefact path (key of the renderer output). */
  moduleRel: string;
  /** Root-relative path to write. */
  rel: string;
}

/** `gen` ids declared by each `modules/ui/<option>/module.json` (only those with a renderer). */
function uiGenIds(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const uiDir = path.join(root, MODULES_UI_DIR);
  if (!fs.existsSync(uiDir)) return out;
  for (const option of fs.readdirSync(uiDir).sort()) {
    const jsonPath = path.join(uiDir, option, "module.json");
    if (!fs.existsSync(jsonPath)) continue;
    // Plain JSON read (`gen` is a string array): the module schema/registry is
    // gone from a finalized tree, this file must keep compiling without it.
    let gen: unknown;
    try {
      gen = (JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { gen?: unknown }).gen;
    } catch {
      continue;
    }
    out.set(
      option,
      (Array.isArray(gen) ? gen : []).filter(
        (g): g is string => typeof g === "string" && g in RENDERERS
      )
    );
  }
  return out;
}

/**
 * Which files gen-theme owns in this root right now: every module copy for ui
 * modules present under `modules/ui`, plus the root copy for the active ui
 * (`.readynative.json`, default nativewind4). When `modules/` is gone the active ui's
 * gen id is assumed to equal its option name.
 */
export function planThemeTargets(root: string, input: ThemeInput, extra: ThemeExtra = {}) {
  const genIds = uiGenIds(root);
  const state = readReadyNativeJson(root);
  const activeUi = state?.selection?.ui ?? "nativewind4";
  const activeGens = genIds.get(activeUi) ?? (activeUi in RENDERERS ? [activeUi] : []);

  const targets: ThemeTarget[] = [];
  const contents: Record<string, string> = {};
  const add = (gen: string, toRoot: boolean) => {
    for (const [moduleRel, content] of Object.entries(RENDERERS[gen](input, extra))) {
      const rel = toRoot ? rootPathOf(moduleRel) : moduleRel;
      if (rel in contents) continue;
      contents[rel] = content;
      targets.push({ gen, moduleRel, rel });
    }
  };
  for (const gens of genIds.values()) for (const gen of gens) add(gen, false);
  for (const gen of activeGens) add(gen, true);
  return { targets, contents };
}

export function themeTargets(root: string, input?: ThemeInput, extra?: ThemeExtra): string[] {
  const probe: ThemeInput = input ?? { light: {}, dark: {}, radius: { sm: 0, md: 0, lg: 0 } };
  return planThemeTargets(root, probe, extra).targets.map((t) => t.rel);
}

export interface GenThemeResult {
  written: string[];
  unchanged: string[];
  /** Targets whose content differs (populated in `check` mode instead of writing). */
  drift: { file: string; summary: string }[];
}

function diffSummary(current: string, next: string): string {
  const a = current.split("\n");
  const b = next.split("\n");
  const lines: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && lines.length < 12; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) lines.push(`-${i + 1}: ${a[i]}`);
      if (b[i] !== undefined) lines.push(`+${i + 1}: ${b[i]}`);
    }
  }
  return lines.join("\n");
}

export async function runGenTheme(options: {
  root: string;
  input: ThemeInput;
  extra?: ThemeExtra;
  check?: boolean;
}): Promise<GenThemeResult> {
  const { root, input, extra = {}, check = false } = options;
  const prettierOptions = loadPrettierOptions(root);
  const { targets, contents } = planThemeTargets(root, input, extra);
  const result: GenThemeResult = { written: [], unchanged: [], drift: [] };
  for (const { rel } of targets) {
    const abs = path.join(root, rel);
    const next = await formatFile(rel, contents[rel], prettierOptions);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
    if (current === next) {
      result.unchanged.push(rel);
      continue;
    }
    if (check) {
      result.drift.push({
        file: rel,
        summary: current === undefined ? "(missing)" : diffSummary(current, next),
      });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    result.written.push(rel);
  }
  return result;
}
