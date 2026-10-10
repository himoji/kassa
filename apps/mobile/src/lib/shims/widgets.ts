/** No-op home-screen widget (contract 5). Replaced by the selected widgets module. */

/**
 * What the app widget shows: one glanceable value with a line above and below it,
 * e.g. `{ title: "Almaty", value: "21°", subtitle: "Partly cloudy · H 24° L 12°" }`.
 * Widgets run outside the app and cannot fetch or read app state - push a new snapshot
 * whenever the value changes.
 */
export interface WidgetSnapshot {
  title: string;
  value: string;
  subtitle?: string;
  /** SF Symbol name for the corner glyph, e.g. "cloud.sun.fill". */
  symbol?: string;
}

/**
 * What a Live Activity shows on the Lock Screen and in the Dynamic Island - the same fields
 * as a widget snapshot, plus an optional 0-1 `progress` bar.
 */
export interface ActivityContent extends WidgetSnapshot {
  progress?: number;
}

export interface LiveActivities {
  /** `false` in the shim, on Android/web, in Expo Go and when the user turned them off. */
  supported: boolean;
  /**
   * Starts the Lock Screen / Dynamic Island activity, or updates it when one is running.
   * Resolves `false` when it could not be shown. Never throws.
   */
  start(content: ActivityContent): Promise<boolean>;
  /** Replaces what the running activity shows; no-op when none is running. */
  update(content: ActivityContent): Promise<void>;
  /** Ends every running activity of this app. */
  end(): Promise<void>;
  /** Whether an activity of this app is on screen right now. */
  isRunning(): boolean;
}

export interface Widgets {
  /** `false` in the shim, on Android/web and in Expo Go: nothing is rendered anywhere. */
  supported: boolean;
  /** Replaces what the home-screen widget shows. Safe to call anywhere; never throws. */
  update(snapshot: WidgetSnapshot): void;
  /** Live Activities: the same data, live on the Lock Screen and in the Dynamic Island. */
  activity: LiveActivities;
}

export const widgets: Widgets = {
  supported: false,
  update: () => {},
  activity: {
    supported: false,
    start: () => Promise.resolve(false),
    update: () => Promise.resolve(),
    end: () => Promise.resolve(),
    isRunning: () => false,
  },
};
