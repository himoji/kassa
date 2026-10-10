/** No-op location (contract 5). Replaced by the selected location module. */

export interface Coords {
  latitude: number;
  longitude: number;
}

/** `unsupported`: no location module, or the platform cannot provide one. */
export type LocationPermission = "unsupported" | "undetermined" | "denied" | "granted";

export interface Location {
  /** `false` in the shim: screens hide "use my location" instead of offering a dead button. */
  supported: boolean;
  /** Current foreground permission, without prompting. */
  getPermission(): Promise<LocationPermission>;
  /** Prompts when the OS still can; resolves with the resulting permission. */
  requestPermission(): Promise<LocationPermission>;
  /**
   * The device position, asking for permission first when it is still undetermined.
   * Resolves `null` when permission is denied or no fix is available - never rejects.
   */
  getCurrentPosition(): Promise<Coords | null>;
  /** Human name for a position ("Almaty"), or `null` when the platform cannot tell. */
  reverseGeocode(coords: Coords): Promise<string | null>;
}

export const location: Location = {
  supported: false,
  getPermission: () => Promise.resolve("unsupported"),
  requestPermission: () => Promise.resolve("unsupported"),
  getCurrentPosition: () => Promise.resolve(null),
  reverseGeocode: () => Promise.resolve(null),
};
