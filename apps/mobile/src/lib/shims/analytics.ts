/** No-op analytics (contract 5). Replaced by the selected analytics module. */

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

/** A flag is a boolean or a variant key; `undefined` means unknown (not loaded, or no provider). */
export type FeatureFlagValue = string | boolean;

export interface Analytics {
  track(name: string, props?: AnalyticsProps): void;
  identify(id: string, traits?: AnalyticsProps): void;
  screen(name: string): void;
  /** `true`/`false` once flags are loaded; `undefined` while unknown or when the provider has no flags. */
  isFeatureEnabled(key: string): boolean | undefined;
  /** The flag's value (boolean or variant key), `undefined` while unknown. */
  getFeatureFlag(key: string): FeatureFlagValue | undefined;
  /** Forget the identity and queued state (sign-out, account deletion, data wipe); ends `suspend()`. */
  reset(): void;
  /**
   * Account deletion: send what is queued, then stop sending (in memory only, the consent record
   * is untouched) so nothing re-creates the person the server is about to erase. Ended by
   * `reset()` (the deletion went through) or `resume()` (it did not).
   */
  suspend(): Promise<void>;
  resume(): void;
}

/**
 * `false` here; every analytics module exports `true`. Settings, the consent sheet and
 * "Do not sell or share" only show analytics controls when a module is selected.
 */
export const analyticsEnabled = false;

export const analytics: Analytics = {
  track: () => {},
  identify: () => {},
  screen: () => {},
  isFeatureEnabled: () => undefined,
  getFeatureFlag: () => undefined,
  reset: () => {},
  suspend: () => Promise.resolve(),
  resume: () => {},
};

/** Re-renders when flags load or change; `undefined` while unknown. No-op provider: always `undefined`. */
export function useFeatureFlag(_key: string): FeatureFlagValue | undefined {
  return undefined;
}
