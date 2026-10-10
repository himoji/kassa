/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ReadyNativeState } from "../lib/readynative-state";
import {
  dataSafetyDraft,
  formatDataSafetyDraft,
  formatStoreFindings,
  hasBlockingFindings,
  isPlaceholderUsageString,
  storeCheck,
  storeTierGate,
  type StoreFinding,
} from "../lib/store-check";
import { TIER_FILE } from "../lib/tier";

/**
 * A tree with the files the check reads, built by hand (no test-utils/fixture: this test
 * ships to buyers with the check). Loaders are injected, so app.config.ts and
 * readynative.config.ts exist only for the `file:line` of a finding.
 */
let root: string;

const write = (rel: string, content: string) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

const CONFIG_TS = `export default {
  urls: {
    website: "https://acme.io",
    support: "mailto:hi@acme.io",
    privacy: "https://acme.io/privacy",
    terms: "https://acme.io/terms",
  },
  features: { reviewPrompt: false },
};
`;

const goodConfig = {
  urls: {
    website: "https://acme.io",
    support: "mailto:hi@acme.io",
    privacy: "https://acme.io/privacy",
    terms: "https://acme.io/terms",
  },
  features: { reviewPrompt: false },
};

/** What setup composes from the storage module's `privacy.accessedApis`. */
const MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
      NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
    },
  ],
};

const goodAppConfig = {
  ios: { infoPlist: { ITSAppUsesNonExemptEncryption: false }, privacyManifests: MANIFEST },
  android: { permissions: ["INTERNET"] },
  plugins: ["expo-router"],
};

function state(selection: Record<string, string>): ReadyNativeState {
  return {
    version: 1,
    preset: null,
    selection,
    applied: true,
    modules: { app: { expo: {} }, postSetup: [], doctor: [] },
    keepModules: false,
    examples: false,
  };
}

const NO_SERVICES = state({ ui: "nativewind5", auth: "none", payments: "none", analytics: "none" });

function pkg(deps: string[]) {
  write(
    "package.json",
    JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "*"])) })
  );
}

const GOOD_PAYWALL = `import { Linking } from "react-native";
export function PaywallScreen() {
  const restore = () => payments.restorePurchases();
  const legal = [{ label: "Terms", url: urls.terms }, { label: "Privacy", url: urls.privacy }];
  return <Text>{pkg.product.priceString} per month</Text>;
}
`;

const SIGN_IN = `export function SignIn() {
  return <><Button>Continue with Apple</Button><Button>Continue with Google</Button></>;
}
`;

interface RunOptions {
  config?: unknown;
  appConfig?: unknown;
  state?: ReadyNativeState;
}

async function run(opts: RunOptions = {}): Promise<StoreFinding[]> {
  return storeCheck(root, {
    loadConfig: async () => opts.config ?? goodConfig,
    loadAppConfig: async () => opts.appConfig ?? goodAppConfig,
    state: opts.state ?? NO_SERVICES,
  });
}

const ids = (findings: StoreFinding[]) => findings.map((f) => f.id);
const byId = (findings: StoreFinding[], id: string) => findings.filter((f) => f.id === id);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "readynative-store-check-"));
  write("readynative.config.ts", CONFIG_TS);
  write("app.config.ts", "export default () => ({});\n");
  pkg(["expo", "expo-router"]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("storeCheck: clean tree", () => {
  it("reports nothing for a tree with no services, legal URLs set and encryption answered", async () => {
    expect(await run()).toEqual([]);
  });
});

describe("storeCheck: iOS usage strings", () => {
  it("blocks a permission-bearing dependency with neither plist key nor plugin", async () => {
    pkg(["expo-location"]);
    const found = byId(await run(), "ios-usage-string-missing");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "block",
      platform: "ios",
      guideline: "App Store Review 5.1.1(i)",
      title: "NSLocationWhenInUseUsageDescription missing",
      file: "app.config.ts",
    });
    expect(found[0].fix).toContain('"expo-location"');
  });

  it("accepts an explicit plist string and blocks a placeholder one", async () => {
    pkg(["expo-camera"]);
    const ok = await run({
      appConfig: {
        ...goodAppConfig,
        ios: {
          infoPlist: {
            ITSAppUsesNonExemptEncryption: false,
            NSCameraUsageDescription: "Scans the fridge to suggest recipes.",
          },
          privacyManifests: MANIFEST,
        },
      },
    });
    expect(ids(ok)).toEqual([]);

    const bad = await run({
      appConfig: {
        ...goodAppConfig,
        ios: {
          infoPlist: {
            ITSAppUsesNonExemptEncryption: false,
            NSCameraUsageDescription: "TODO explain",
          },
        },
      },
    });
    expect(byId(bad, "ios-usage-string-placeholder")).toHaveLength(1);
    expect(bad[0].severity).toBe("block");
  });

  it("is satisfied by the plugin with a *Permission prop, and only informs on the plugin default", async () => {
    pkg(["expo-image-picker"]);
    const explained = await run({
      appConfig: {
        ...goodAppConfig,
        plugins: [["expo-image-picker", { photosPermission: "Attach photos to notes." }]],
      },
    });
    expect(ids(explained)).toEqual([]);

    const bare = await run({ appConfig: { ...goodAppConfig, plugins: ["expo-image-picker"] } });
    // Two keys (photos + camera) both fall back to the plugin default.
    const info = byId(bare, "ios-usage-string-default");
    expect(info).toHaveLength(2);
    expect(info.every((f) => f.severity === "info")).toBe(true);
    expect(hasBlockingFindings(bare)).toBe(false);
  });

  it("warns when expo-notifications is installed without its plugin", async () => {
    pkg(["expo-notifications"]);
    expect(byId(await run(), "notifications-plugin-missing")).toMatchObject([
      { severity: "warn", platform: "both" },
    ]);
    const withPlugin = await run({
      appConfig: { ...goodAppConfig, plugins: [["expo-notifications", { icon: "./x.png" }]] },
    });
    expect(ids(withPlugin)).toEqual([]);
  });

  it("recognises placeholder strings", () => {
    expect(isPlaceholderUsageString("")).toBe(true);
    expect(isPlaceholderUsageString("   ")).toBe(true);
    expect(isPlaceholderUsageString("TODO: write this")).toBe(true);
    expect(isPlaceholderUsageString("Lorem ipsum dolor")).toBe(true);
    expect(isPlaceholderUsageString("Allow $(PRODUCT_NAME) to use your location")).toBe(false);
    expect(isPlaceholderUsageString("Tags entries with where you wrote them.")).toBe(false);
  });
});

describe("storeCheck: export compliance and Android permissions", () => {
  it("blocks when ITSAppUsesNonExemptEncryption is not answered", async () => {
    const found = byId(await run({ appConfig: { ios: {}, plugins: [] } }), "ios-encryption-unset");
    expect(found).toMatchObject([
      { severity: "block", platform: "ios", guideline: "App Store Connect export compliance" },
    ]);
  });

  it("accepts either answer", async () => {
    const yes = await run({
      appConfig: {
        ...goodAppConfig,
        ios: { infoPlist: { ITSAppUsesNonExemptEncryption: true }, privacyManifests: MANIFEST },
      },
    });
    expect(ids(yes)).toEqual([]);
  });

  it("warns on an Android permission no dependency justifies, with or without the prefix", async () => {
    pkg(["expo-location"]);
    const found = await run({
      appConfig: {
        ...goodAppConfig,
        plugins: [["expo-location", { locationWhenInUsePermission: "Tags entries." }]],
        android: {
          permissions: [
            "INTERNET",
            "ACCESS_FINE_LOCATION",
            "android.permission.READ_CONTACTS",
            "RECORD_AUDIO",
          ],
        },
      },
    });
    const warned = byId(found, "android-permission-unjustified");
    expect(warned.map((f) => f.title)).toEqual([
      "android.permissions has READ_CONTACTS that no dependency needs",
      "android.permissions has RECORD_AUDIO that no dependency needs",
    ]);
    expect(warned[0]).toMatchObject({
      severity: "warn",
      platform: "android",
      guideline: "Play Permissions policy",
    });
    expect(warned[0].fix).toContain('"android.permission.READ_CONTACTS"');
  });
});

describe("storeCheck: App Tracking Transparency", () => {
  it("warns when analytics is selected without expo-tracking-transparency", async () => {
    const found = await run({ state: state({ analytics: "posthog" }) });
    expect(byId(found, "att-not-installed")).toMatchObject([
      { severity: "warn", platform: "ios", guideline: "App Store Review 5.1.2(i)" },
    ]);
  });

  it("blocks when it is installed without NSUserTrackingUsageDescription", async () => {
    pkg(["expo-tracking-transparency"]);
    const found = await run({ state: state({ analytics: "posthog" }) });
    expect(byId(found, "att-not-installed")).toEqual([]);
    expect(byId(found, "ios-usage-string-missing")).toMatchObject([
      {
        severity: "block",
        title: "NSUserTrackingUsageDescription missing",
        guideline: "App Store Review 5.1.2(i)",
      },
    ]);
  });

  it("blocks when features.tracking is on without the library", async () => {
    const found = await run({
      state: state({ analytics: "posthog" }),
      config: { ...goodConfig, features: { tracking: true } },
    });
    expect(byId(found, "att-not-installed")).toMatchObject([{ severity: "block" }]);
  });

  it("informs when the library is installed but the prompt is off", async () => {
    pkg(["expo-tracking-transparency"]);
    const found = await run({ state: state({ analytics: "posthog" }) });
    expect(byId(found, "att-flag-off")).toMatchObject([
      { severity: "info", platform: "ios", file: "readynative.config.ts" },
    ]);
    expect(byId(found, "att-not-installed")).toEqual([]);
  });

  it("is quiet when the string is set and tracking is on, or analytics is off", async () => {
    pkg(["expo-tracking-transparency"]);
    const set = await run({
      state: state({ analytics: "amplitude" }),
      config: { ...goodConfig, features: { tracking: true } },
      appConfig: {
        ...goodAppConfig,
        ios: {
          infoPlist: {
            ITSAppUsesNonExemptEncryption: false,
            NSUserTrackingUsageDescription: "Measures which ads brought you here.",
          },
          privacyManifests: MANIFEST,
        },
      },
    });
    expect(ids(set)).toEqual([]);
    pkg(["expo"]);
    expect(ids(await run({ state: state({ analytics: "none" }) }))).toEqual([]);
  });
});

describe("storeCheck: legal URLs", () => {
  it("blocks empty or non-https privacy and terms URLs, with the line in readynative.config.ts", async () => {
    const found = await run({
      config: {
        urls: { privacy: "", terms: "http://acme.io/terms", support: "mailto:hi@acme.io" },
      },
    });
    expect(byId(found, "privacy-policy-url")).toMatchObject([
      {
        severity: "block",
        platform: "both",
        guideline: "App Store Review 5.1.1(i) · Play User Data policy",
        file: "readynative.config.ts",
        line: 5,
      },
    ]);
    expect(byId(found, "terms-url")).toMatchObject([
      {
        severity: "block",
        guideline: "App Store Review 3.1.2(a) · Play Subscriptions policy",
        line: 6,
      },
    ]);
    expect(byId(found, "support-url")).toEqual([]);
  });

  it("warns on an empty support URL (mailto: alone counts as empty)", async () => {
    const found = await run({
      config: { ...goodConfig, urls: { ...goodConfig.urls, support: "mailto:" } },
    });
    expect(byId(found, "support-url")).toMatchObject([
      { severity: "warn", guideline: "App Store Review 1.5", line: 4 },
    ]);
  });

  it("warns instead of crashing when readynative.config.ts cannot be loaded", async () => {
    const found = await storeCheck(root, {
      loadConfig: async () => {
        throw new Error("boom");
      },
      loadAppConfig: async () => goodAppConfig,
      state: NO_SERVICES,
    });
    expect(found).toMatchObject([
      { id: "readynative-config-load", severity: "warn", detail: "boom" },
    ]);
  });

  it("warns instead of crashing when app.config.ts cannot be evaluated", async () => {
    const found = await storeCheck(root, {
      loadConfig: async () => goodConfig,
      loadAppConfig: async () => {
        throw new Error("no expo here");
      },
      state: NO_SERVICES,
    });
    expect(found).toMatchObject([
      { id: "app-config-load", severity: "warn", file: "app.config.ts" },
    ]);
  });
});

describe("storeCheck: paywall", () => {
  const paid = state({ auth: "none", payments: "revenuecat" });

  it("passes a paywall with restore, legal links and a price", async () => {
    write("src/screens/paywall/paywall-screen.tsx", GOOD_PAYWALL);
    expect(ids(await run({ state: paid }))).toEqual([]);
  });

  it("warns when no paywall file exists at all", async () => {
    expect(byId(await run({ state: paid }), "paywall-not-found")).toMatchObject([
      { severity: "warn", guideline: "App Store Review 3.1.1" },
    ]);
  });

  it("blocks each missing element separately, pointing at the screen file", async () => {
    write(
      "src/app/paywall/index.tsx",
      "export { PaywallScreen as default } from '@/screens/paywall';\n"
    );
    write(
      "src/screens/paywall/paywall-screen.tsx",
      "export function PaywallScreen() { return <Button>Buy</Button>; }\n"
    );
    const found = await run({ state: paid });
    expect(ids(found)).toEqual(["paywall-restore", "paywall-legal-links", "paywall-price"]);
    expect(found.every((f) => f.severity === "block")).toBe(true);
    expect(found.every((f) => f.file === "src/screens/paywall/paywall-screen.tsx")).toBe(true);
    expect(found.map((f) => f.guideline)).toEqual([
      "App Store Review 3.1.1",
      "App Store Review 3.1.2(a)",
      "App Store Review 3.1.2(a) · Play Subscriptions policy",
    ]);
  });

  it("does not look at the paywall when payments is none", async () => {
    write("src/screens/paywall/paywall-screen.tsx", "export function PaywallScreen() {}\n");
    expect(ids(await run())).toEqual([]);
  });

  it("blocks an external checkout for Stripe only, with the line of the call", async () => {
    write(
      "src/screens/paywall/paywall-screen.tsx",
      GOOD_PAYWALL.replace(
        "const restore",
        "const open = (u: string) => Linking.openURL(u);\n  const restore"
      )
    );
    const stripe = await run({ state: state({ payments: "stripe" }) });
    expect(byId(stripe, "paywall-external-checkout")).toMatchObject([
      {
        severity: "block",
        platform: "both",
        guideline: "App Store Review 3.1.1 · 3.1.3 · Play Payments policy",
        file: "src/screens/paywall/paywall-screen.tsx",
        line: 3,
      },
    ]);
    expect(stripe[0].detail).toMatch(/regions/);
    expect(ids(await run({ state: paid }))).toEqual([]);
  });
});

describe("storeCheck: accounts", () => {
  const withAuth = state({ auth: "supabase", payments: "none" });
  const DELETE_SQL = "supabase/migrations/20260921000000_delete_user.sql";

  beforeEach(() => {
    write(DELETE_SQL, "create or replace function public.delete_user() returns void ...\n");
  });

  it("blocks auth without any account deletion", async () => {
    write(
      "src/screens/settings/settings-screen.tsx",
      "export function Settings() { return <Row title='Sign out' />; }\n"
    );
    expect(byId(await run({ state: withAuth }), "account-deletion")).toMatchObject([
      {
        severity: "block",
        platform: "both",
        guideline: "App Store Review 5.1.1(v) · Play Account deletion",
      },
    ]);
  });

  it("is satisfied by a delete route or by a screen that deletes the account", async () => {
    write("src/app/settings/delete-account.tsx", "export default function DeleteAccount() {}\n");
    expect(ids(await run({ state: withAuth }))).toEqual([]);
    fs.rmSync(path.join(root, "src/app"), { recursive: true });

    write(
      "src/screens/settings/settings-screen.tsx",
      "<Row title={t('Delete account')} destructive />\n"
    );
    expect(ids(await run({ state: withAuth }))).toEqual([]);

    write("src/screens/settings/settings-screen.tsx", "<Row title='Account deletion' />\n");
    expect(ids(await run({ state: withAuth }))).toEqual([]);

    write(
      "src/screens/settings/settings-screen.tsx",
      "<Row title={t('Remove')} onPress={() => void auth.deleteAccount()} />\n"
    );
    expect(ids(await run({ state: withAuth }))).toEqual([]);
  });

  it("supabase: notes when the delete_user migration is gone", async () => {
    write(
      "src/screens/settings/settings-screen.tsx",
      "<Row title={t('Delete account')} destructive />\n"
    );
    fs.rmSync(path.join(root, DELETE_SQL));
    expect(byId(await run({ state: withAuth }), "account-deletion-rpc")).toMatchObject([
      { severity: "info", platform: "both" },
    ]);
    expect(ids(await run({ state: state({ auth: "clerk", payments: "none" }) }))).toEqual([]);
  });

  it("does not require deletion without auth", async () => {
    expect(ids(await run({ state: state({ auth: "none" }) }))).toEqual([]);
  });

  it("blocks Google sign-in without Sign in with Apple, citing the line", async () => {
    write(
      "src/screens/auth/sign-in-screen.tsx",
      "export function SignIn() {\n  return <Button>Continue with Google</Button>;\n}\n"
    );
    write("src/app/settings/delete-account.tsx", "export default function DeleteAccount() {}\n");
    const found = await run({ state: withAuth });
    expect(byId(found, "sign-in-with-apple")).toMatchObject([
      {
        severity: "block",
        platform: "ios",
        guideline: "App Store Review 4.8",
        file: "src/screens/auth/sign-in-screen.tsx",
        line: 2,
      },
    ]);
    write("src/screens/auth/sign-in-screen.tsx", SIGN_IN);
    expect(ids(await run({ state: withAuth }))).toEqual([]);
  });

  it("ignores test files under the screens", async () => {
    write("src/screens/auth/__tests__/sign-in.test.tsx", "it('google', () => {});\n");
    expect(ids(await run())).toEqual([]);
  });
});

describe("storeCheck: review prompt", () => {
  it("only informs when features.reviewPrompt is on", async () => {
    const found = await run({ config: { ...goodConfig, features: { reviewPrompt: true } } });
    expect(found).toMatchObject([
      { id: "review-prompt", severity: "info", guideline: "App Store Review 1.1.7" },
    ]);
    expect(hasBlockingFindings(found)).toBe(false);
  });
});

describe("storeTierGate", () => {
  it("gates a Free or Starter tree, runs everywhere else", () => {
    expect(storeTierGate(root)).toBeNull();
    write(TIER_FILE, JSON.stringify({ tier: "pro", label: "Pro", version: "1.0.0", sdk: 57 }));
    expect(storeTierGate(root)).toBeNull();
    for (const [tier, label] of [
      ["starter", "Starter"],
      ["free", "Free"],
    ]) {
      write(TIER_FILE, JSON.stringify({ tier, label, version: "1.0.0", sdk: 57 }));
      expect(storeTierGate(root)).toMatch(
        /^doctor --store is part of ReadyNative Pro - https?:\/\/.*\/docs\/pass-app-review$/
      );
    }
  });
});

describe("dataSafetyDraft", () => {
  const ROW = {
    sdk: "Supabase (auth/supabase)",
    collects: ["Email address, name (account)"],
    sharedWith: "Supabase (processor)",
    disclosureUrl: "https://supabase.com/privacy",
  };
  const withRows = (rows: (typeof ROW)[]) => ({
    ...state({ auth: "supabase" }),
    modules: { app: { expo: {} }, postSetup: [], doctor: [], privacy: { dataSafety: rows } },
  });

  it("returns the rows setup composed into .readynative.json, and nothing for older trees", () => {
    expect(dataSafetyDraft(withRows([ROW]))).toEqual([ROW]);
    expect(dataSafetyDraft(state({ auth: "supabase" }))).toEqual([]);
    expect(dataSafetyDraft(undefined)).toEqual([]);
  });

  it("formats as a table with the review reminder, empty when there is nothing", () => {
    const text = formatDataSafetyDraft(dataSafetyDraft(withRows([ROW])));
    expect(text).toContain("review before you fill in the form");
    expect(text).toContain("- Supabase (auth/supabase)");
    expect(text).toContain("disclosure: https://supabase.com/privacy");
    expect(formatDataSafetyDraft([])).toBe("");
  });
});

describe("storeCheck: privacy manifest", () => {
  it("warns when ios.privacyManifests is missing", async () => {
    const found = await run({
      appConfig: {
        ...goodAppConfig,
        ios: goodAppConfig.ios && { infoPlist: goodAppConfig.ios.infoPlist },
      },
    });
    expect(byId(found, "privacy-manifest-missing")).toMatchObject([
      { severity: "warn", platform: "ios", file: "app.config.ts" },
    ]);
  });

  it("warns when the manifest declares tracking without the ATT flag", async () => {
    const tracking = {
      ...goodAppConfig,
      ios: { ...goodAppConfig.ios, privacyManifests: { ...MANIFEST, NSPrivacyTracking: true } },
    };
    expect(
      byId(await run({ appConfig: tracking }), "privacy-manifest-tracking-mismatch")
    ).toHaveLength(1);
    const ok = await run({
      appConfig: tracking,
      config: { ...goodConfig, features: { tracking: true } },
    });
    expect(byId(ok, "privacy-manifest-tracking-mismatch")).toEqual([]);
  });
});

describe("formatStoreFindings", () => {
  const findings: StoreFinding[] = [
    {
      id: "review-prompt",
      severity: "info",
      platform: "ios",
      guideline: "App Store Review 1.1.7",
      title: "Prompt on",
      detail: "d1",
      fix: "f1",
    },
    {
      id: "support-url",
      severity: "warn",
      platform: "both",
      guideline: "App Store Review 1.5",
      title: "No support",
      detail: "d2",
      file: "readynative.config.ts",
      line: 3,
      fix: "f2",
    },
    {
      id: "paywall-restore",
      severity: "block",
      platform: "ios",
      guideline: "App Store Review 3.1.1",
      title: "No restore",
      detail: "d3",
      file: "src/screens/paywall/paywall-screen.tsx",
      fix: "f3",
    },
  ];

  it("groups by severity with block first, and prints id, guideline, location and fix", () => {
    const text = formatStoreFindings(findings);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Blocking - fix before you submit (1)");
    expect(lines[1]).toBe("✗ No restore  [paywall-restore · ios · App Store Review 3.1.1]");
    expect(lines[2]).toBe("    src/screens/paywall/paywall-screen.tsx");
    expect(lines[3]).toBe("    d3");
    expect(lines[4]).toBe("    fix: f3");
    expect(text.indexOf("Blocking")).toBeLessThan(text.indexOf("Warnings"));
    expect(text.indexOf("Warnings")).toBeLessThan(text.indexOf("Info"));
    expect(text).toContain(
      "! No support  [support-url · both · App Store Review 1.5]\n    readynative.config.ts:3"
    );
    expect(text).toContain("i Prompt on  [review-prompt · ios · App Store Review 1.1.7]");
  });

  it("says so when there is nothing to report, and hasBlockingFindings drives the exit code", () => {
    expect(formatStoreFindings([])).toMatch(/pass/);
    expect(hasBlockingFindings([])).toBe(false);
    expect(hasBlockingFindings(findings.slice(0, 2))).toBe(false);
    expect(hasBlockingFindings(findings)).toBe(true);
  });
});
