import { Appearance } from "react-native";

import type { ResolvedMode, ThemeMode } from "./tokens";

/**
 * Resolve a user preference against the OS scheme. Pure; used by the store,
 * the hook and tests. `systemScheme` accepts RN's `ColorSchemeName`
 * (`"unspecified"` on 0.86 when the OS reports nothing) - anything but
 * `"dark"` resolves to light.
 */
export function resolveMode(
  mode: ThemeMode,
  systemScheme: ResolvedMode | "unspecified" | null | undefined
): ResolvedMode {
  if (mode === "light" || mode === "dark") return mode;
  return systemScheme === "dark" ? "dark" : "light";
}

/**
 * Apply a theme preference to `Appearance` (native only).
 *
 * NativeWind 5 derives dark mode from `prefers-color-scheme`, which on native
 * follows `Appearance`. RN 0.86 restores "follow the OS" with `"unspecified"`
 * (older RN accepted `null`).
 *
 * react-native-web's `Appearance` only mirrors the browser media query and has
 * no `setColorScheme`, so this is a no-op on web. Forced modes still apply
 * there: `useResolvedMode` resolves the stored preference itself and the
 * NativeWind `ThemeProvider` pushes the matching colour variables through
 * `VariableContextProvider`.
 */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof Appearance.setColorScheme !== "function") return;
  Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
}
