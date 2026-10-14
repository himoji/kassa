import type { ReadyNativeConfig } from "./src/lib/readynative-config";

/**
 * THE file a buyer edits: app identity, brand, urls, store ids, deep-link domain, feature toggles.
 *
 * Read by `app.config.ts` (bundle ids / names per APP_VARIANT), `src/theme/tokens.ts`
 * (brand → tokens), the settings screen (urls) and `bun doctor` (placeholder warnings).
 * Must stay importable under plain Node: only import types from `src/`.
 */
export default {
  app: {
    name: "Kassa",
    slug: "kassa",
    scheme: "kassa",
    owner: "madikshshs",
    easProjectId: "5899622f-c225-4911-b74c-d87a17211226",
    ios: { bundleId: "app.kassa.mobile" },
    android: { package: "app.kassa.mobile" },
  },
  brand: { primary: "#171717", accent: "#2563eb", radius: 12, font: "Inter" },
  urls: { website: "", support: "mailto:", privacy: "", terms: "" },
  store: { appStoreId: "", playPackage: "" },
  links: { domain: "", appleTeamId: "", androidCertFingerprints: [] },
  features: { reviewPrompt: true, updatesBanner: true, tracking: false },
  privacy: { askEverywhere: false },
} satisfies ReadyNativeConfig;
