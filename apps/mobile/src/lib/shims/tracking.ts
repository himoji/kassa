/**
 * No-op App Tracking Transparency (contract 5). Replaced by the selected
 * analytics module, which ships `expo-tracking-transparency`; without one
 * nothing tracks, so every status reads `unavailable`.
 */

export type TrackingStatus = "granted" | "denied" | "undetermined" | "unavailable";

export interface Tracking {
  /** Current ATT status; `unavailable` off iOS or when no analytics module ships the prompt. */
  getStatus(): Promise<TrackingStatus>;
  /**
   * Shows the ATT prompt (once; later calls return the stored answer). Honours
   * `readynative.features.tracking` - `false` never prompts and reports the status.
   */
  requestPermission(): Promise<TrackingStatus>;
}

export const tracking: Tracking = {
  getStatus: () => Promise.resolve("unavailable"),
  requestPermission: () => Promise.resolve("unavailable"),
};

/** Reactive status; the shim never changes. */
export function useTrackingStatus(): TrackingStatus {
  return "unavailable";
}
