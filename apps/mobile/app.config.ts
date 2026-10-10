import type { ExpoConfig } from "expo/config";
import fs from "node:fs";
import path from "node:path";

// Explicit `.ts` extension: Expo loads this file through Node's native type-stripping, which
// resolves only literal paths (no extension probing). tsc accepts it via allowImportingTsExtensions.
import config from "./readynative.config.ts";

type Variant = "dev" | "preview" | "prod";

// Expo's config loader compiles this file to CommonJS, where `__dirname` exists; `doctor`
// imports it through node's native type stripping (ESM), where only `import.meta` does.
declare const __dirname: string | undefined;
const APP_ROOT = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;

const VARIANT = (process.env.APP_VARIANT ?? "dev") as Variant;

const variantMeta: Record<Variant, { nameSuffix: string; idSuffix: string }> = {
  dev: { nameSuffix: " (Dev)", idSuffix: ".dev" },
  preview: { nameSuffix: " (Preview)", idSuffix: ".preview" },
  prod: { nameSuffix: "", idSuffix: "" },
};

const { nameSuffix, idSuffix } = variantMeta[VARIANT] ?? variantMeta.dev;

type Plugin = NonNullable<ExpoConfig["plugins"]>[number];
type ModuleAppPatch = { expo?: Partial<ExpoConfig> & { plugins?: Plugin[] } };

/**
 * Module app patch (docs/module-spec.md "app patch"): `bun setup` writes the
 * merged `app.expo` of every selected module to `.readynative.json`; modules
 * never edit this file. `plugins` append-unique by id, other keys deep-merge.
 */
function readModuleAppPatch(): Partial<ExpoConfig> {
  const file = path.join(APP_ROOT, ".readynative.json");
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      modules?: { app?: ModuleAppPatch };
    };
    return parsed.modules?.app?.expo ?? {};
  } catch (err) {
    console.warn("[app.config] ignoring unreadable .readynative.json", err);
    return {};
  }
}

function pluginId(plugin: Plugin): string {
  return Array.isArray(plugin) ? String(plugin[0]) : String(plugin);
}

/** Google's advertising-id permission; blocked unless the app tracks (features.tracking). */
const AD_ID_PERMISSION = "com.google.android.gms.permission.AD_ID";

/**
 * App Tracking Transparency follows `features.tracking` (readynative.config.ts), not the module
 * list. With it off, the ATT config plugin is dropped (it adds Android's AD_ID permission), AD_ID
 * is blocked outright (analytics / payments SDKs can pull it in) and the privacy manifest says
 * `NSPrivacyTracking: false` with no tracking domains. The `NSUserTrackingUsageDescription`
 * string an analytics module sets stays: the library is still linked, and App Store Connect
 * flags a linked ATT framework without it (ITMS-90683) - it is never shown while nothing asks.
 * With it on, the manifest says `true` and the plugin stays.
 */
export function applyTrackingPolicy(
  patch: Partial<ExpoConfig>,
  tracking: boolean
): Partial<ExpoConfig> {
  const manifests = patch.ios?.privacyManifests;
  const privacyManifests = manifests
    ? {
        ...manifests,
        NSPrivacyTracking: tracking,
        NSPrivacyTrackingDomains: tracking ? (manifests.NSPrivacyTrackingDomains ?? []) : [],
      }
    : tracking
      ? { NSPrivacyTracking: true }
      : undefined;
  const ios = privacyManifests ? { ...patch.ios, privacyManifests } : patch.ios;
  if (tracking) return { ...patch, ...(ios ? { ios } : {}) };

  const blocked = patch.android?.blockedPermissions ?? [];
  return {
    ...patch,
    ...(ios ? { ios } : {}),
    ...(patch.plugins
      ? { plugins: patch.plugins.filter((p) => pluginId(p) !== "expo-tracking-transparency") }
      : {}),
    android: {
      ...patch.android,
      blockedPermissions: blocked.includes(AD_ID_PERMISSION)
        ? blocked
        : [...blocked, AD_ID_PERMISSION],
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function applyModulePatch(config: ExpoConfig, patch: Partial<ExpoConfig>): ExpoConfig {
  const { plugins: patchPlugins = [], ...rest } = patch;
  const plugins = [...(config.plugins ?? [])];
  const ids = new Set(plugins.map(pluginId));
  for (const plugin of patchPlugins) {
    if (ids.has(pluginId(plugin))) continue;
    ids.add(pluginId(plugin));
    plugins.push(plugin);
  }
  return {
    ...deepMerge(config as unknown as Record<string, unknown>, rest),
    plugins,
  } as ExpoConfig;
}

// Universal links / App Links (docs: README "Deep links"). Both keys are native config, so
// changing `links.domain` needs a rebuild; the matching AASA / assetlinks.json files come from
// `bun run gen:links`. Absent (not empty arrays) when no domain is set.
const linksDomain = config.links.domain.trim();
const associatedDomains = linksDomain ? { associatedDomains: [`applinks:${linksDomain}`] } : {};
const intentFilters = linksDomain
  ? {
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [{ scheme: "https", host: linksDomain, pathPrefix: "/" }],
          category: ["BROWSABLE", "DEFAULT"],
        },
      ],
    }
  : {};

// EAS project linking. `eas init` cannot write into a dynamic config, it only prints the id:
// the buyer pastes it into `readynative.config.ts` (app.easProjectId), CI sets EAS_PROJECT_ID.
// `updates.url` is derived from it and stays absent until then (an empty url breaks expo-updates).
const easProjectId = (process.env.EAS_PROJECT_ID ?? config.app.easProjectId ?? "").trim();
const updates = easProjectId ? { updates: { url: `https://u.expo.dev/${easProjectId}` } } : {};

// iOS icon: an Icon Composer file (layered, Liquid Glass) at `assets/expo.icon` wins when you add
// one; otherwise iOS uses the same `icon` PNG as everything else, which `bun run gen:assets`
// regenerates from `assets/brand/icon.png`. (No placeholder `.icon` ships - it would pin the
// Expo logo on iOS no matter what gen:assets writes.)
const iosIcon = fs.existsSync(path.join(APP_ROOT, "assets", "expo.icon"))
  ? { icon: "./assets/expo.icon" }
  : {};

const baseConfig = ({ config: base }: { config: Partial<ExpoConfig> }): ExpoConfig => ({
  ...base,
  name: `${config.app.name}${nameSuffix}`,
  slug: config.app.slug,
  // Expo account / organisation that owns the EAS project; omitted when unset (personal account).
  owner: config.app.owner || undefined,
  version: base.version ?? "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: config.app.scheme,
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "appVersion" },
  ...updates,
  ios: {
    ...iosIcon,
    bundleIdentifier: `${config.app.ios.bundleId}${idSuffix}`,
    ...associatedDomains,
    infoPlist: {
      // Only HTTPS / OS-provided crypto: answers App Store Connect's export-compliance question
      // up front. Set it to true (and file the paperwork) if you ship your own encryption.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      backgroundColor: config.brand.primary,
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    package: `${config.app.android.package}${idSuffix}`,
    ...intentFilters,
  },
  web: {
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: config.brand.primary,
        image: "./assets/images/splash-icon.png",
        imageWidth: 76,
      },
    ],
    "expo-dev-client",
    // iOS 27: adopt the UIScene life cycle (see the plugin header).
    "./plugins/with-scene-lifecycle.js",
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appVariant: VARIANT,
    eas: {
      // Empty until the buyer links their own EAS project (see `easProjectId` above).
      projectId: easProjectId,
    },
  },
});

/** `features.tracking`; a tree cut without the tracking feature (Free) has no `features` at all. */
function tracksUsers(c: unknown): boolean {
  return (c as { features?: { tracking?: unknown } }).features?.tracking === true;
}

export default (ctx: { config: Partial<ExpoConfig> }): ExpoConfig =>
  applyModulePatch(baseConfig(ctx), applyTrackingPolicy(readModuleAppPatch(), tracksUsers(config)));
