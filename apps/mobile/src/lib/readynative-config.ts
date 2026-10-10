/**
 * Shape of `readynative.config.ts` - the one file a buyer edits.
 *
 * Keep this file dependency-free: it is imported by `app.config.ts` under
 * Node (no React Native, no Expo runtime) as well as by `src/theme/tokens.ts`.
 */

export type AppVariant = "dev" | "preview" | "prod";

export interface ReadyNativeAppConfig {
  /** Display name shown under the icon. */
  name: string;
  /** Expo project slug (EAS). */
  slug: string;
  /** Deep-link scheme, e.g. `readynative://`. */
  scheme: string;
  /**
   * Expo account or organisation slug that owns the EAS project. Required when the project
   * belongs to an org (and for CI builds with an org `EXPO_TOKEN`). Empty → omitted.
   */
  owner?: string;
  /**
   * EAS project id: paste the id printed by `bunx eas-cli init` (it cannot write into a
   * dynamic `app.config.ts`). Feeds `extra.eas.projectId` and `updates.url`; the
   * `EAS_PROJECT_ID` env var wins over it in CI. Empty → project not linked.
   */
  easProjectId?: string;
  ios: { bundleId: string };
  android: { package: string };
}

export interface ReadyNativeBrandConfig {
  /** Hex colour; overrides the light `primary` token. */
  primary: string;
  /** Hex colour; exposed as the `brandAccent` token. */
  accent: string;
  /** Base corner radius in px; `radius.lg`. Other steps derive from it. */
  radius: number;
  /** Font family name loaded via `expo-font`. */
  font: string;
}

export interface ReadyNativeUrlsConfig {
  website: string;
  /** `mailto:` or https URL used by the settings screen. */
  support: string;
  privacy: string;
  terms: string;
}

export interface ReadyNativeStoreConfig {
  /** Numeric App Store id (for review prompts / store links). */
  appStoreId: string;
  /** Play Store package (usually equals `app.android.package`). */
  playPackage: string;
}

export interface ReadyNativeLinksConfig {
  /**
   * Bare host used for iOS universal links / Android App Links, e.g. `app.example.com`
   * (no scheme, no path). Empty → universal links off (no associatedDomains / intentFilters).
   */
  domain: string;
  /** 10-character Apple Team ID (developer.apple.com → Membership); prefixes the AASA app ids. */
  appleTeamId: string;
  /** SHA-256 fingerprints of the Android signing certs; `eas credentials` prints them. */
  androidCertFingerprints: string[];
}

export interface ReadyNativeFeaturesConfig {
  reviewPrompt: boolean;
  updatesBanner: boolean;
  tracking: boolean; // ATT prompt before analytics.identify - only if you link data across companies (ads, IDFA)
}

export interface ReadyNativePrivacyConfig {
  /**
   * Show the consent sheet to everyone, not only where the device looks like the EU/EEA, UK,
   * Switzerland, Canada or Brazil. Undecided analytics / crash reporting then stay off
   * everywhere until the user answers. Only read when the consent module is selected.
   */
  askEverywhere: boolean;
}

export interface ReadyNativeConfig {
  app: ReadyNativeAppConfig;
  brand: ReadyNativeBrandConfig;
  urls: ReadyNativeUrlsConfig;
  store: ReadyNativeStoreConfig;
  links: ReadyNativeLinksConfig;
  features: ReadyNativeFeaturesConfig;
  /** Optional so configs written before it keep compiling; missing = `{ askEverywhere: false }`. */
  privacy?: ReadyNativePrivacyConfig;
}
