/**
 * readynative.config.ts `links` + bundle ids → the two files a domain must serve for
 * universal links (iOS) and App Links (Android):
 *
 * - `public/.well-known/apple-app-site-association` (no extension, JSON body)
 * - `public/.well-known/assetlinks.json`
 *
 * Expo serves `public/` on web export, so hosting the web app at `links.domain` is
 * enough. `app.config.ts` suffixes bundle ids per APP_VARIANT (`.dev`, `.preview`,
 * none for prod), so every file lists all three ids. Empty team id / fingerprints
 * render as visible placeholders (`TEAM_ID`, `SHA256_FINGERPRINT`) so the output
 * always exists and `bun doctor` is what flags them. Output is prettier-formatted
 * (the tree is prettier-formatted, so raw JSON.stringify would drift on the next `format`).
 */
import fs from "node:fs";
import path from "node:path";

import { formatJson, loadPrettierOptions } from "./format.ts";

export const AASA_PATH = "public/.well-known/apple-app-site-association";
export const ASSETLINKS_PATH = "public/.well-known/assetlinks.json";
export const TEAM_ID_PLACEHOLDER = "TEAM_ID";
export const FINGERPRINT_PLACEHOLDER = "SHA256_FINGERPRINT";

/** Must match `variantMeta[*].idSuffix` in app.config.ts. */
export const VARIANT_ID_SUFFIXES = ["", ".preview", ".dev"] as const;

/** The slice of `ReadyNativeConfig` gen-links reads (structural so fixtures stay small). */
export interface LinksConfigInput {
  app: { ios: { bundleId: string }; android: { package: string } };
  links: { domain?: string; appleTeamId?: string; androidCertFingerprints?: string[] };
}

export interface Aasa {
  applinks: { details: { appIDs: string[]; components: Record<string, string>[] }[] };
  webcredentials: { apps: string[] };
}

export interface AssetLink {
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
}

export interface LinksDrift {
  file: string;
  reason: "missing" | "differs";
}

function variantIds(base: string): string[] {
  return VARIANT_ID_SUFFIXES.map((suffix) => `${base}${suffix}`);
}

function teamId(config: LinksConfigInput): string {
  return config.links.appleTeamId?.trim() || TEAM_ID_PLACEHOLDER;
}

function fingerprints(config: LinksConfigInput): string[] {
  const list = (config.links.androidCertFingerprints ?? []).map((f) => f.trim()).filter(Boolean);
  return list.length ? list : [FINGERPRINT_PLACEHOLDER];
}

export function aasa(config: LinksConfigInput): Aasa {
  const team = teamId(config);
  const appIDs = variantIds(config.app.ios.bundleId).map((id) => `${team}.${id}`);
  return {
    applinks: { details: [{ appIDs, components: [{ "/": "/*" }] }] },
    webcredentials: { apps: appIDs },
  };
}

export function assetlinks(config: LinksConfigInput): AssetLink[] {
  const sha256_cert_fingerprints = fingerprints(config);
  return variantIds(config.app.android.package).map((package_name) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name, sha256_cert_fingerprints },
  }));
}

/**
 * root-relative path → file content (prettier JSON: 2-space, trailing newline). `root` only
 * picks up a custom `.prettierrc`; the repo defaults apply when omitted.
 */
export async function renderLinks(
  config: LinksConfigInput,
  root?: string
): Promise<Record<string, string>> {
  const options = root ? loadPrettierOptions(root) : undefined;
  return {
    [AASA_PATH]: await formatJson(JSON.stringify(aasa(config)), options),
    [ASSETLINKS_PATH]: await formatJson(JSON.stringify(assetlinks(config)), options),
  };
}

/** Writes both files under `root` (mkdir -p); returns the root-relative paths written. */
export async function writeLinks(root: string, config: LinksConfigInput): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(await renderLinks(config, root))) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  return written;
}

/** Files under `root` that are missing or differ from what `renderLinks` would write. */
export async function checkLinks(root: string, config: LinksConfigInput): Promise<LinksDrift[]> {
  const drift: LinksDrift[] = [];
  for (const [rel, content] of Object.entries(await renderLinks(config, root))) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      drift.push({ file: rel, reason: "missing" });
    } else if (fs.readFileSync(abs, "utf8") !== content) {
      drift.push({ file: rel, reason: "differs" });
    }
  }
  return drift;
}
