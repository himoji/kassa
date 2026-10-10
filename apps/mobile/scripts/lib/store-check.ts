/**
 * `doctor --store`: the mechanical half of an App Store / Google Play review.
 *
 * Static checks over `package.json`, the evaluated `app.config.ts`, `readynative.config.ts`
 * and the screens under `src/` - usage strings, export compliance, ATT, legal URLs, the
 * paywall, account deletion, Sign in with Apple - each finding citing the guideline it
 * comes from and the concrete fix. The judgement half (reading the screens like a
 * reviewer) is the `store-review` agent skill; this file only finds what a regex can.
 *
 * Ships in both tiers; `doctor` gates it on `.readynative-tier.json` at runtime. Like the
 * rest of the kept scripts it must not import the module system (catalog, registry).
 */
import fs from "node:fs";
import path from "node:path";

import { defaultLoadAppConfig, defaultLoadConfig } from "./doctor.ts";
import {
  DOCS_URL,
  readReadyNativeJson,
  type DataSafetyRow,
  type ReadyNativeState,
} from "./readynative-state.ts";
import { readTier } from "./tier.ts";

export type StoreSeverity = "block" | "warn" | "info";
export type StorePlatform = "ios" | "android" | "both";

export interface StoreFinding {
  /** Stable id (`paywall-restore`); tests and the skill key on it. */
  id: string;
  severity: StoreSeverity;
  platform: StorePlatform;
  /** Citation: `App Store Review 3.1.1`, `Play User Data policy`, … */
  guideline: string;
  title: string;
  detail: string;
  /** Root-relative. */
  file?: string;
  line?: number;
  fix: string;
}

export interface StoreCheckOptions {
  /** Load `readynative.config.ts` default export (tests inject a value). */
  loadConfig?: (root: string) => Promise<unknown>;
  /** Resolve `app.config.ts` the way Expo does. */
  loadAppConfig?: (root: string) => Promise<unknown>;
  /** Override `.readynative.json` (tests). */
  state?: ReadyNativeState;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface PermissionDep {
  dep: string;
  /** Info.plist purpose strings the dep's API needs; its config plugin injects defaults. */
  plistKeys: string[];
  /** Android permissions the dep's plugin / manifest adds - what justifies them. */
  android: string[];
  /** Config plugin id when it differs from the package (none do today). */
  plugin?: string;
  /** Guideline the purpose string falls under; 5.1.1(i) unless the dep is about tracking. */
  guideline?: string;
}

/**
 * Permission-bearing Expo modules. `plistKeys` follow the SDK docs of each module;
 * `android` is the union its plugin can add (not every entry is always added, so the
 * Android check treats them as *justified*, never as *required*).
 */
export const PERMISSION_DEPS: PermissionDep[] = [
  {
    dep: "expo-location",
    plistKeys: ["NSLocationWhenInUseUsageDescription"],
    android: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
    ],
  },
  {
    dep: "expo-camera",
    plistKeys: ["NSCameraUsageDescription"],
    android: ["CAMERA", "RECORD_AUDIO"],
  },
  {
    dep: "expo-image-picker",
    plistKeys: ["NSPhotoLibraryUsageDescription", "NSCameraUsageDescription"],
    android: [
      "CAMERA",
      "READ_EXTERNAL_STORAGE",
      "WRITE_EXTERNAL_STORAGE",
      "READ_MEDIA_IMAGES",
      "READ_MEDIA_VIDEO",
    ],
  },
  {
    dep: "expo-contacts",
    plistKeys: ["NSContactsUsageDescription"],
    android: ["READ_CONTACTS", "WRITE_CONTACTS"],
  },
  {
    dep: "expo-calendar",
    plistKeys: ["NSCalendarsUsageDescription", "NSRemindersUsageDescription"],
    android: ["READ_CALENDAR", "WRITE_CALENDAR"],
  },
  {
    dep: "expo-media-library",
    plistKeys: ["NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription"],
    android: [
      "READ_EXTERNAL_STORAGE",
      "WRITE_EXTERNAL_STORAGE",
      "ACCESS_MEDIA_LOCATION",
      "READ_MEDIA_IMAGES",
      "READ_MEDIA_VIDEO",
      "READ_MEDIA_AUDIO",
    ],
  },
  {
    dep: "expo-av",
    plistKeys: ["NSMicrophoneUsageDescription"],
    android: ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"],
  },
  {
    dep: "expo-audio",
    plistKeys: ["NSMicrophoneUsageDescription"],
    android: ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"],
  },
  {
    // No purpose string on iOS; the plugin is what registers the notification icon /
    // colour and the Android 13+ runtime permission.
    dep: "expo-notifications",
    plistKeys: [],
    android: [
      "POST_NOTIFICATIONS",
      "VIBRATE",
      "RECEIVE_BOOT_COMPLETED",
      "SCHEDULE_EXACT_ALARM",
      "USE_EXACT_ALARM",
      "com.google.android.c2dm.permission.RECEIVE",
    ],
  },
  {
    dep: "expo-tracking-transparency",
    plistKeys: ["NSUserTrackingUsageDescription"],
    android: ["com.google.android.gms.permission.AD_ID"],
    guideline: "App Store Review 5.1.2(i)",
  },
];

/** Android permissions no dependency has to justify: networking, vibration, wake locks. */
const ANDROID_ALWAYS_OK = new Set([
  "INTERNET",
  "ACCESS_NETWORK_STATE",
  "ACCESS_WIFI_STATE",
  "CHANGE_NETWORK_STATE",
  "CHANGE_WIFI_STATE",
  "VIBRATE",
  "WAKE_LOCK",
  "FOREGROUND_SERVICE",
  "USE_BIOMETRIC",
  "USE_FINGERPRINT",
  "SYSTEM_ALERT_WINDOW",
  "MODIFY_AUDIO_SETTINGS",
  "REQUEST_INSTALL_PACKAGES",
  "com.google.android.c2dm.permission.RECEIVE",
]);

/** A purpose string a reviewer would see through: empty, or left with a marker in it. */
const PLACEHOLDER_RE = /\b(todo|fixme|tbd|lorem|xxx|placeholder|change ?me)\b/i;

export function isPlaceholderUsageString(value: string): boolean {
  return value.trim() === "" || PLACEHOLDER_RE.test(value);
}

export type { DataSafetyRow } from "./readynative-state.ts";

/**
 * Rows for the selected service modules, composed by setup from each module's
 * `privacy.playDataSafety` and stored in `.readynative.json` (`modules/` is gone
 * from a finalized tree, so this never reads module.json). Best-effort and
 * static: the buyer fills in the Play Console form from the vendor page.
 */
export function dataSafetyDraft(state: ReadyNativeState | undefined): DataSafetyRow[] {
  return state?.modules?.privacy?.dataSafety ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AppConfigShape {
  ios?: { infoPlist?: Record<string, unknown>; privacyManifests?: Record<string, unknown> };
  android?: { permissions?: unknown };
  plugins?: unknown[];
}

interface ConfigShape {
  urls?: Record<string, unknown>;
  features?: { reviewPrompt?: unknown; tracking?: unknown };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `plugins` entry → `[id, props]`; a bare string has no props. */
function pluginEntry(plugin: unknown): [string, Record<string, unknown>] | undefined {
  if (typeof plugin === "string") return [plugin, {}];
  if (Array.isArray(plugin) && typeof plugin[0] === "string")
    return [plugin[0], asObject(plugin[1])];
  return undefined;
}

function readDeps(root: string): Set<string> {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

/** Files under `dir` (recursive, sorted, root-relative posix), skipping tests and mocks. */
function listFiles(root: string, dir: string, filter: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__tests__" || entry.name === "__mocks__" || entry.name === "node_modules")
        continue;
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (filter(next)) out.push(next);
    }
  };
  walk(dir);
  return out;
}

const SOURCE_RE = /\.(tsx?|jsx?)$/;

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** 1-based line of the first match, or undefined. */
function lineOf(text: string, re: RegExp): number | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  return text.slice(0, m.index).split("\n").length;
}

function isHttps(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/\S+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const APP_CONFIG = "app.config.ts";
const READYNATIVE_CONFIG = "readynative.config.ts";

function permissionChecks(deps: Set<string>, appConfig: AppConfigShape): StoreFinding[] {
  const out: StoreFinding[] = [];
  const infoPlist = asObject(appConfig.ios?.infoPlist);
  const plugins = new Map<string, Record<string, unknown>>();
  for (const plugin of appConfig.plugins ?? []) {
    const entry = pluginEntry(plugin);
    if (entry) plugins.set(entry[0], entry[1]);
  }

  for (const spec of PERMISSION_DEPS) {
    if (!deps.has(spec.dep)) continue;
    const pluginId = spec.plugin ?? spec.dep;
    const pluginProps = plugins.get(pluginId);
    const guideline = spec.guideline ?? "App Store Review 5.1.1(i)";

    if (spec.plistKeys.length === 0) {
      if (!pluginProps) {
        out.push({
          id: "notifications-plugin-missing",
          severity: "warn",
          platform: "both",
          guideline: "App Store Review 4.5.4 · Play Permissions policy",
          title: `${spec.dep} installed without its config plugin`,
          detail:
            "The plugin registers the notification icon/colour and the Android 13+ POST_NOTIFICATIONS runtime permission; without it Android shows no prompt and notifications are silently off.",
          file: APP_CONFIG,
          fix: `Add ["${spec.dep}", { icon, color }] to plugins in ${APP_CONFIG} (setup does this for push/expo-notifications).`,
        });
      }
      continue;
    }

    for (const key of spec.plistKeys) {
      const value = infoPlist[key];
      if (typeof value === "string") {
        if (isPlaceholderUsageString(value)) {
          out.push({
            id: "ios-usage-string-placeholder",
            severity: "block",
            platform: "ios",
            guideline,
            title: `${key} is a placeholder`,
            detail: `${spec.dep} prompts with "${value}" - Apple rejects empty or obviously unfinished purpose strings.`,
            file: APP_CONFIG,
            fix: `Set ios.infoPlist.${key} to one sentence saying what the app does with the data.`,
          });
        }
        continue;
      }
      if (value !== undefined) continue; // non-string: not ours to judge
      if (pluginProps) {
        const explained = Object.keys(pluginProps).some((k) => /permission/i.test(k));
        if (!explained) {
          out.push({
            id: "ios-usage-string-default",
            severity: "info",
            platform: "ios",
            guideline,
            title: `${key} uses the ${spec.dep} plugin default`,
            detail:
              'The plugin injects "Allow $(PRODUCT_NAME) to …" - accepted, but vague strings are a common 5.1.1 rejection reason.',
            file: APP_CONFIG,
            fix: `Pass the plugin's *Permission prop (e.g. ["${spec.dep}", { …Permission: "…" }]) with a sentence specific to your app.`,
          });
        }
        continue;
      }
      out.push({
        id: "ios-usage-string-missing",
        severity: "block",
        platform: "ios",
        guideline,
        title: `${key} missing`,
        detail: `${spec.dep} is installed and its API prompts for this permission; without the string the prompt crashes the app on iOS and the build is rejected.`,
        file: APP_CONFIG,
        fix: `Add the "${pluginId}" config plugin to plugins (with its *Permission prop) or set ios.infoPlist.${key}.`,
      });
    }
  }
  return out;
}

function androidPermissionChecks(deps: Set<string>, appConfig: AppConfigShape): StoreFinding[] {
  const raw = appConfig.android?.permissions;
  if (!Array.isArray(raw)) return [];
  const justified = new Set(ANDROID_ALWAYS_OK);
  for (const spec of PERMISSION_DEPS) {
    if (deps.has(spec.dep)) for (const p of spec.android) justified.add(p);
  }
  const out: StoreFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.replace(/^android\.permission\./, "");
    if (justified.has(name) || justified.has(entry)) continue;
    out.push({
      id: "android-permission-unjustified",
      severity: "warn",
      platform: "android",
      guideline: "Play Permissions policy",
      title: `android.permissions has ${name} that no dependency needs`,
      detail:
        "Play asks for a justification of every sensitive permission and rejects ones the app does not visibly use.",
      file: APP_CONFIG,
      fix: `Remove "${entry}" from android.permissions in ${APP_CONFIG}, or add the dependency that uses it.`,
    });
  }
  return out;
}

function encryptionCheck(appConfig: AppConfigShape): StoreFinding[] {
  const infoPlist = asObject(appConfig.ios?.infoPlist);
  if (infoPlist.ITSAppUsesNonExemptEncryption !== undefined) return [];
  return [
    {
      id: "ios-encryption-unset",
      severity: "block",
      platform: "ios",
      guideline: "App Store Connect export compliance",
      title: "ITSAppUsesNonExemptEncryption not set",
      detail:
        "Every upload stops at 'Missing Compliance' in App Store Connect until this is answered; HTTPS-only apps qualify as exempt.",
      file: APP_CONFIG,
      fix: "Set ios.infoPlist.ITSAppUsesNonExemptEncryption: false (true only if you ship your own cryptography).",
    },
  ];
}

function attCheck(
  deps: Set<string>,
  selection: Record<string, string>,
  config: ConfigShape | undefined
): StoreFinding[] {
  const analytics = selection.analytics;
  if (!analytics || analytics === "none") return [];
  const tracks = config?.features?.tracking === true;
  if (deps.has("expo-tracking-transparency")) {
    // The usage string itself is checked by permissionChecks.
    if (tracks) return [];
    return [
      {
        id: "att-flag-off",
        severity: "info",
        platform: "ios",
        guideline: "App Store Review 5.1.2(i)",
        title: "App Tracking Transparency prompt is off (features.tracking: false)",
        detail:
          "expo-tracking-transparency is installed but the prompt never shows. First-party product analytics with no IDFA and no ad network is not tracking, so this is the right default - answer 'No' to tracking in App Store Connect.",
        file: READYNATIVE_CONFIG,
        fix: "If you do link data across companies (ads attribution, IDFA), set features.tracking: true; analytics.identify then waits for consent.",
      },
    ];
  }
  return [
    {
      id: "att-not-installed",
      severity: tracks ? "block" : "warn",
      platform: "ios",
      guideline: "App Store Review 5.1.2(i)",
      title: tracks
        ? "features.tracking is on but expo-tracking-transparency is not installed"
        : `analytics/${analytics} selected without expo-tracking-transparency`,
      detail: tracks
        ? "The flag promises an ATT prompt; without the library nothing asks and Apple rejects tracking without consent."
        : "App Store Connect asks whether the app tracks users. First-party product analytics with no IDFA and no ad network does not, so this is fine as long as you answer 'no' there and never share the device id with third parties for advertising.",
      fix: "`npx expo install expo-tracking-transparency`, add its plugin with a purpose string (the analytics modules ship both) and let AnalyticsProvider call tracking.requestPermission().",
    },
  ];
}

/**
 * Apple requires a privacy manifest for apps using required-reason APIs
 * (UserDefaults, file timestamps...) and wants collected data types declared;
 * setup composes it from the modules' `privacy` into `ios.privacyManifests`.
 */
function privacyManifestCheck(
  appConfig: AppConfigShape,
  config: ConfigShape | undefined
): StoreFinding[] {
  const manifest = appConfig.ios?.privacyManifests;
  if (!manifest) {
    return [
      {
        id: "privacy-manifest-missing",
        severity: "warn",
        platform: "ios",
        guideline: "App Store Connect · privacy manifest (ITMS-91053)",
        title: "No ios.privacyManifests in the app config",
        detail:
          "Every storage module reads UserDefaults (a required-reason API), so App Store Connect emails ITMS-91053 warnings and, since spring 2024, can reject uploads without a manifest. Setup composes one from the selected modules' privacy declarations.",
        file: APP_CONFIG,
        fix: "Re-run `bun run setup` (the manifest lands in .readynative.json → modules.app.expo.ios.privacyManifests), or add ios.privacyManifests by hand.",
      },
    ];
  }
  if (manifest.NSPrivacyTracking === true && config?.features?.tracking !== true) {
    return [
      {
        id: "privacy-manifest-tracking-mismatch",
        severity: "warn",
        platform: "ios",
        guideline: "App Store Review 5.1.2(i)",
        title: "Privacy manifest declares tracking but features.tracking is off",
        detail:
          "NSPrivacyTracking: true tells Apple the app tracks; without the ATT prompt (features.tracking) that is a rejection.",
        file: READYNATIVE_CONFIG,
        fix: "Set features.tracking: true (the prompt then runs) or drop the tracking flag from the module that declares it.",
      },
    ];
  }
  return [];
}

function urlChecks(root: string, config: ConfigShape): StoreFinding[] {
  const urls = asObject(config.urls);
  const text = fs.existsSync(path.join(root, READYNATIVE_CONFIG))
    ? read(root, READYNATIVE_CONFIG)
    : "";
  const at = (key: string) => ({
    file: READYNATIVE_CONFIG,
    line: lineOf(text, new RegExp(`^\\s*${key}\\s*:`, "m")),
  });
  const out: StoreFinding[] = [];
  if (!isHttps(urls.privacy)) {
    out.push({
      id: "privacy-policy-url",
      severity: "block",
      platform: "both",
      guideline: "App Store Review 5.1.1(i) · Play User Data policy",
      title: "urls.privacy is not an https URL",
      detail:
        "Both stores require a public privacy policy URL in the listing and reachable from inside the app (settings, paywall, sign-in).",
      ...at("privacy"),
      fix: "Publish a privacy policy and set urls.privacy to its https URL in readynative.config.ts.",
    });
  }
  if (!isHttps(urls.terms)) {
    out.push({
      id: "terms-url",
      severity: "block",
      platform: "both",
      guideline: "App Store Review 3.1.2(a) · Play Subscriptions policy",
      title: "urls.terms is not an https URL",
      detail:
        "Subscriptions must link to Terms of Use (EULA) in the app and in the listing; the paywall and settings read this URL.",
      ...at("terms"),
      fix: "Publish terms (Apple's standard EULA counts) and set urls.terms to its https URL in readynative.config.ts.",
    });
  }
  const support = typeof urls.support === "string" ? urls.support.trim() : "";
  if (!support || support === "mailto:") {
    out.push({
      id: "support-url",
      severity: "warn",
      platform: "both",
      guideline: "App Store Review 1.5",
      title: "urls.support is empty",
      detail: "App Store Connect requires a support URL and reviewers do open it.",
      ...at("support"),
      fix: "Set urls.support to an https page or mailto: address in readynative.config.ts.",
    });
  }
  return out;
}

function paywallChecks(root: string, selection: Record<string, string>): StoreFinding[] {
  const payments = selection.payments;
  if (!payments || payments === "none") return [];
  const files = listFiles(root, "src", (rel) => SOURCE_RE.test(rel) && /paywall/i.test(rel));
  if (files.length === 0) {
    return [
      {
        id: "paywall-not-found",
        severity: "warn",
        platform: "both",
        guideline: "App Store Review 3.1.1",
        title: `payments/${payments} selected but no paywall screen found`,
        detail: "Looked for a file named *paywall* under src/. The IAP checks below could not run.",
        fix: "Keep the paywall under src/screens/paywall/ (or name the file paywall-*.tsx).",
      },
    ];
  }
  // The screen carries the UI; the route under src/app is a wrapper. Prefer the screen.
  const screen = files.find((f) => f.startsWith("src/screens/")) ?? files[0];
  const sources = files.map((f) => read(root, f));
  const all = sources.join("\n");
  const out: StoreFinding[] = [];
  if (!/restore/i.test(all)) {
    out.push({
      id: "paywall-restore",
      severity: "block",
      platform: "ios",
      guideline: "App Store Review 3.1.1",
      title: "Paywall has no Restore Purchases action",
      detail: "Apps offering subscriptions or non-consumables must let users restore them.",
      file: screen,
      fix: "Add a 'Restore purchases' button that calls payments.restorePurchases().",
    });
  }
  if (!(/terms/i.test(all) && /privacy/i.test(all))) {
    out.push({
      id: "paywall-legal-links",
      severity: "block",
      platform: "both",
      guideline: "App Store Review 3.1.2(a)",
      title: "Paywall does not link Terms and Privacy",
      detail:
        "Subscription screens must show links to Terms of Use and the privacy policy before purchase.",
      file: screen,
      fix: "Render readynative.urls.terms and readynative.urls.privacy as links on the paywall.",
    });
  }
  if (!/price|period|\/month|\/year|packages/i.test(all)) {
    out.push({
      id: "paywall-price",
      severity: "block",
      platform: "both",
      guideline: "App Store Review 3.1.2(a) · Play Subscriptions policy",
      title: "Paywall does not render price and billing period",
      detail:
        "The price, billing period and what renews must be visible before the purchase button.",
      file: screen,
      fix: "Show product.priceString and the package period next to each purchase option.",
    });
  }
  if (payments === "stripe") {
    const re = /Linking\.openURL|WebBrowser\.|openBrowserAsync|openAuthSessionAsync/;
    const idx = sources.findIndex((s) => re.test(s));
    if (idx !== -1) {
      out.push({
        id: "paywall-external-checkout",
        severity: "block",
        platform: "both",
        guideline: "App Store Review 3.1.1 · 3.1.3 · Play Payments policy",
        title: "Paywall opens an external checkout for digital goods",
        detail:
          "Unlocking app features through Stripe Checkout in a browser is only allowed in specific regions/programs (US external purchase link entitlement, EU alternative terms, reader apps, Play's user-choice billing pilot). Everywhere else digital content must use In-App Purchase / Google Play Billing.",
        file: files[idx],
        line: lineOf(sources[idx], re),
        fix: "Ship payments/revenuecat (or adapty) for the store builds, or apply for the external purchase entitlement and keep Stripe for web only.",
      });
    }
  }
  return out;
}

function accountDeletionCheck(root: string, selection: Record<string, string>): StoreFinding[] {
  const auth = selection.auth;
  if (!auth || auth === "none") return [];
  const routes = listFiles(
    root,
    "src/app",
    (rel) => SOURCE_RE.test(rel) && /^delete/i.test(path.posix.basename(rel))
  );
  const re = /delete\s+(my\s+|your\s+|the\s+)?account|account\s+delet|auth\.deleteAccount\(/i;
  const screens = listFiles(root, "src/screens", (rel) => SOURCE_RE.test(rel));
  const inApp = routes.length > 0 || screens.some((rel) => re.test(read(root, rel)));
  if (!inApp) {
    return [
      {
        id: "account-deletion",
        severity: "block",
        platform: "both",
        guideline: "App Store Review 5.1.1(v) · Play Account deletion",
        title: `auth/${auth} selected but no account deletion in the app`,
        detail:
          "Apps with account creation must offer in-app account deletion (not just sign-out), and Play needs a web URL for it in the Data safety form.",
        fix: "The template's Settings screen ships a 'Delete account' row calling auth.deleteAccount(); restore it, or add a route under src/app/settings/delete-account.tsx that opens your deletion page.",
      },
    ];
  }
  // Supabase's anon client cannot delete users: the row calls rpc('delete_user'), which the
  // shipped migration defines. Static check only - the project's schema is not reachable here.
  if (auth === "supabase") {
    const migrations = listFiles(root, "supabase", (rel) => /delete_user.*\.sql$/i.test(rel));
    if (migrations.length === 0) {
      return [
        {
          id: "account-deletion-rpc",
          severity: "info",
          platform: "both",
          guideline: "App Store Review 5.1.1(v) · Play Account deletion",
          title: "Supabase delete_user() migration is missing from the tree",
          detail:
            "Settings → Delete account calls rpc('delete_user'); without that function in your project the row fails at runtime.",
          fix: "Restore supabase/migrations/20260921000000_delete_user.sql (a security-definer function deleting auth.users for auth.uid()) and apply it with `supabase db push`.",
        },
      ];
    }
  }
  return [];
}

function signInWithAppleCheck(root: string): StoreFinding[] {
  const files = listFiles(root, "src/screens/auth", (rel) => SOURCE_RE.test(rel));
  if (files.length === 0) return [];
  const sources = files.map((f) => read(root, f));
  const social = /google|facebook|github|twitter|microsoft/i;
  const idx = sources.findIndex((s) => social.test(s));
  if (idx === -1) return [];
  if (sources.some((s) => /apple/i.test(s))) return [];
  return [
    {
      id: "sign-in-with-apple",
      severity: "block",
      platform: "ios",
      guideline: "App Store Review 4.8",
      title: "Third-party sign-in without Sign in with Apple",
      detail:
        "An app that offers Google/Facebook/GitHub login must offer an equivalent privacy-preserving option; Sign in with Apple is the accepted one.",
      file: files[idx],
      line: lineOf(sources[idx], social),
      fix: "Add the 'Continue with Apple' button (expo-apple-authentication; the auth modules expose signInWithApple).",
    },
  ];
}

function reviewPromptCheck(config: ConfigShape): StoreFinding[] {
  if (config.features?.reviewPrompt !== true) return [];
  return [
    {
      id: "review-prompt",
      severity: "info",
      platform: "ios",
      guideline: "App Store Review 1.1.7",
      title: "features.reviewPrompt is on",
      detail:
        "Only the system prompt (expo-store-review) is allowed, at most three times a year, and never right after an action or as a gate; the shim already rate-limits, keep it that way.",
      file: READYNATIVE_CONFIG,
      fix: "Nothing to do unless you moved the prompt into a flow the reviewer will hit on first launch.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * The store check is a Pro feature. The gate is the tier marker assemble writes: a
 * Free or Starter tree gets the message returned here instead of the check; a tree
 * without a marker (the monorepo, the example apps, fixtures) is not a buyer tree and
 * just runs it.
 */
export function storeTierGate(root: string): string | null {
  const tier = readTier(root);
  return tier && tier.tier !== "pro"
    ? `doctor --store is part of ReadyNative Pro - ${DOCS_URL}/docs/pass-app-review`
    : null;
}

export async function storeCheck(
  root: string,
  opts: StoreCheckOptions = {}
): Promise<StoreFinding[]> {
  const findings: StoreFinding[] = [];
  const state = opts.state ?? readReadyNativeJson(root);
  const selection = state?.selection ?? {};
  const deps = readDeps(root);

  // app.config.ts - iOS purpose strings, export compliance, Android permissions.
  let appConfig: AppConfigShape | undefined;
  if (opts.loadAppConfig || fs.existsSync(path.join(root, APP_CONFIG))) {
    try {
      appConfig = (
        opts.loadAppConfig ? await opts.loadAppConfig(root) : await defaultLoadAppConfig(root)
      ) as AppConfigShape;
    } catch (e) {
      findings.push({
        id: "app-config-load",
        severity: "warn",
        platform: "both",
        guideline: "-",
        title: `${APP_CONFIG} could not be evaluated`,
        detail: (e as Error).message,
        file: APP_CONFIG,
        fix: "Fix the error above; the permission, encryption and Android checks were skipped.",
      });
    }
  } else {
    findings.push({
      id: "app-config-missing",
      severity: "warn",
      platform: "both",
      guideline: "-",
      title: `${APP_CONFIG} not found`,
      detail: "The permission, encryption and Android checks need the evaluated Expo config.",
      fix: "Run from the app root (`--root <dir>`).",
    });
  }
  if (appConfig) {
    findings.push(...permissionChecks(deps, appConfig));
    findings.push(...encryptionCheck(appConfig));
    findings.push(...androidPermissionChecks(deps, appConfig));
  }
  // readynative.config.ts - legal URLs, review prompt, tracking flag.
  let config: ConfigShape | undefined;
  if (opts.loadConfig || fs.existsSync(path.join(root, READYNATIVE_CONFIG))) {
    try {
      config = (
        opts.loadConfig ? await opts.loadConfig(root) : await defaultLoadConfig(root)
      ) as ConfigShape;
    } catch (e) {
      findings.push({
        id: "readynative-config-load",
        severity: "warn",
        platform: "both",
        guideline: "-",
        title: `${READYNATIVE_CONFIG} could not be loaded`,
        detail: (e as Error).message,
        file: READYNATIVE_CONFIG,
        fix: "Fix the error above; the privacy/terms/support URL checks were skipped.",
      });
    }
  } else {
    findings.push({
      id: "readynative-config-missing",
      severity: "warn",
      platform: "both",
      guideline: "-",
      title: `${READYNATIVE_CONFIG} not found`,
      detail: "The privacy/terms/support URL checks need it.",
      fix: "Run from the app root (`--root <dir>`).",
    });
  }
  findings.push(...attCheck(deps, selection, config));
  if (appConfig) findings.push(...privacyManifestCheck(appConfig, config));
  if (config) {
    findings.push(...urlChecks(root, config));
    findings.push(...reviewPromptCheck(config));
  }

  // Screens.
  findings.push(...paywallChecks(root, selection));
  findings.push(...accountDeletionCheck(root, selection));
  findings.push(...signInWithAppleCheck(root));

  return findings;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: StoreSeverity[] = ["block", "warn", "info"];
const SEVERITY_LABEL: Record<StoreSeverity, string> = {
  block: "Blocking - fix before you submit",
  warn: "Warnings - likely questions from review",
  info: "Info",
};
const SEVERITY_ICON: Record<StoreSeverity, string> = { block: "✗", warn: "!", info: "i" };

export function hasBlockingFindings(findings: StoreFinding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

/** Grouped by severity, `block` first; each finding with its citation, location and fix. */
export function formatStoreFindings(findings: StoreFinding[]): string {
  if (findings.length === 0) return "No store findings - the mechanical checks pass.";
  const sections: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const lines = [`${SEVERITY_LABEL[severity]} (${group.length})`];
    for (const f of group) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
      lines.push(
        `${SEVERITY_ICON[severity]} ${f.title}  [${f.id} · ${f.platform} · ${f.guideline}]`
      );
      if (where) lines.push(`    ${where}`);
      lines.push(`    ${f.detail}`);
      lines.push(`    fix: ${f.fix}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/** The Data safety draft as a text table; empty string when nothing is selected. */
export function formatDataSafetyDraft(rows: DataSafetyRow[]): string {
  if (rows.length === 0) return "";
  const lines = [
    "Play Data safety draft - review before you fill in the form (vendor page = source of truth)",
  ];
  for (const row of rows) {
    lines.push(`- ${row.sdk}`);
    lines.push(`    collects: ${row.collects.join("; ")}`);
    lines.push(`    shared with: ${row.sharedWith}`);
    lines.push(`    disclosure: ${row.disclosureUrl}`);
  }
  return lines.join("\n");
}
