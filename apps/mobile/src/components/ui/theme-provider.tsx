import { ThemeProvider as NavigationThemeProvider } from "expo-router";
import { colorScheme as nativewindColorScheme, vars } from "nativewind";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { View } from "react-native";

import { useResolvedMode, useThemeMode } from "@/stores/theme-mode";
import { getNavigationTheme } from "@/theme/navigation";
import { colors, radius, space, type ResolvedMode, type ThemeMode } from "@/theme/tokens";
import type { Theme, ThemeProviderProps } from "@/components/ui/types";

import { hslVariables } from "./hsl";

/**
 * Resolved mode for the current subtree. `null` outside any provider, in
 * which case `useTheme` falls back to the store-resolved mode.
 */
const ModeContext = createContext<ResolvedMode | null>(null);

/**
 * Tell NativeWind 4 which scheme is active (`darkMode: "class"` in
 * `tailwind.config.js`, so it never follows the OS on its own). On native
 * this is `Appearance.setColorScheme` - the same call `setThemeMode` already
 * makes - on web it toggles the `dark` class on `<html>`, which is the only
 * way `.dark:root` variables apply there.
 */
function applyNativewindScheme(mode: ThemeMode): void {
  try {
    nativewindColorScheme.set(mode);
  } catch {
    // Web throws outside a browser (static export) - nothing to apply there.
  }
}

/**
 * NativeWind 4 theme provider.
 *
 * Reads the persisted preference (hydrated once by the root layout), pushes
 * it into NativeWind's colour scheme and hands the resolved mode to the
 * `@/components/ui` theme context and React Navigation.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const preference = useThemeMode();
  const mode = useResolvedMode();
  const navigationTheme = useMemo(() => getNavigationTheme(mode), [mode]);

  useEffect(() => {
    applyNativewindScheme(preference);
  }, [preference]);

  return (
    <ModeContext value={mode}>
      <NavigationThemeProvider value={navigationTheme}>{children}</NavigationThemeProvider>
    </ModeContext>
  );
}

/**
 * Force a scheme on a subtree regardless of the user preference. Adapter
 * extra (not part of `UiKit`); used by the dev catalog to preview dark mode.
 *
 * NativeWind 4 has no variable-context provider, so the subtree is wrapped in
 * a `View` carrying `vars()` with that mode's HSL triples: `bg-background`-style
 * classes below it resolve against the forced values. `dark:` variant classes
 * still follow the global scheme (they are keyed on it, not on variables).
 */
export function ForcedMode({ mode, children }: { mode: ResolvedMode; children: ReactNode }) {
  const variables = useMemo(() => vars(hslVariables(mode)), [mode]);
  return (
    <ModeContext value={mode}>
      <View style={variables}>{children}</View>
    </ModeContext>
  );
}

export function useTheme(): Theme {
  const scoped = useContext(ModeContext);
  const resolved = useResolvedMode();
  const mode = scoped ?? resolved;
  return useMemo(() => ({ mode, colors: colors[mode], space, radius }), [mode]);
}
