/**
 * `.readynative.json` - the record of what `bun setup` applied.
 *
 * Deliberately free of any module-system import (catalog, registry, schema):
 * the scripts that survive setup (`doctor`, `gen-theme`) read the state from
 * here, so they keep compiling once `scripts/lib/{catalog,registry,resolve}.ts`
 * are gone from the buyer's tree (see `finalize.ts`).
 */
import fs from "node:fs";
import path from "node:path";

import type { PmName } from "./pm.ts";

export const READYNATIVE_JSON = ".readynative.json";

/**
 * The docs site every guide link points at. `READYNATIVE_DOCS_URL` (no trailing slash
 * required) swings the links at a local `apps/docs` server while writing them.
 *
 * The docs-link helpers live here rather than in `lib/paths.ts` for the same reason the
 * state does: `finalize` prunes `scripts/lib/paths.ts` out of a buyer tree, and `doctor`
 * still has to print these links there. `lib/paths.ts` re-exports them.
 */
export const DOCS_URL =
  process.env.READYNATIVE_DOCS_URL?.replace(/\/$/, "") || "https://readynative.app";

/** Where a module's "how do I set this service up" walkthrough lives. */
export function moduleGuideUrl(category: string, option: string, anchor = "setup"): string {
  return `${DOCS_URL}/docs/features/${category}/${option}#${anchor}`;
}

/**
 * Docs home pre-loaded with a selection (`?stack=ui:tamagui,auth:supabase`), so the pages
 * a buyer lands on show their own stack. `none` / `off` categories are left out - they are
 * the absence of a choice. Categories keep the key order of `selection`, which is catalog
 * order both in `.readynative.json` and in what `setup` passes.
 */
export function stackUrl(selection: Record<string, string>): string {
  const stack = Object.entries(selection)
    .filter(([, option]) => option && option !== "none" && option !== "off")
    .map(([category, option]) => `${category}:${option}`)
    .join(",");
  return stack ? `${DOCS_URL}/docs/?stack=${stack}` : `${DOCS_URL}/docs/`;
}

/** A module `doctor` check as stored in `.readynative.json` (schema.ts `DoctorCheck` + origin). */
export type StoredDoctorCheck = ({ type: "env"; keys: string[] } | { type: "devBuild" }) & {
  module: string;
  docsUrls?: Record<string, string>;
  /**
   * Absolute URL of the module's setup guide (`moduleGuideUrl`). Optional: trees written
   * before the field existed simply have no guide to cite.
   */
  guide?: string;
};

/** One SDK's row in the Play Data safety draft (declared in module.json `privacy.playDataSafety`). */
export interface DataSafetyRow {
  sdk: string;
  /** Play Data safety categories, roughly. */
  collects: string[];
  sharedWith: string;
  /** The vendor's own disclosure / privacy page - the source of truth for the form. */
  disclosureUrl: string;
}

export interface ReadyNativeState {
  version: 1;
  preset: string | null;
  /** category → option. Widened to strings: the catalog is gone after setup. */
  selection: Record<string, string>;
  applied: true;
  modules: {
    /** `{ expo: <merged app.expo of every selected module> }` - read by app.config.ts. */
    app: { expo: Record<string, unknown> };
    postSetup: string[];
    doctor: StoredDoctorCheck[];
    /**
     * Composed from the selected modules' `privacy`: the Play Data safety draft rows
     * `doctor --store` prints. Absent on trees written before the field existed.
     */
    privacy?: { dataSafety: DataSafetyRow[] };
  };
  keepModules: boolean;
  /**
   * The package manager setup ran with (`bun` unless the buyer chose another one).
   * Absent on trees written before the field existed - treat that as `bun`.
   */
  packageManager?: PmName;
  /** False when setup stripped the demo screens/UI catalog (the default). */
  examples: boolean;
}

export function readReadyNativeJson(root: string): ReadyNativeState | undefined {
  const file = path.join(root, READYNATIVE_JSON);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text) as ReadyNativeState;
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
}
