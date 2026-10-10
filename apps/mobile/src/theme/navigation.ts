import { DarkTheme, DefaultTheme, type Theme } from "expo-router";

import { colors, type ResolvedMode } from "./tokens";

/**
 * React Navigation theme built from our tokens.
 *
 * expo-router 57 vendors React Navigation; `@react-navigation/native` is not a
 * resolvable package, so the base themes come from `expo-router`.
 */
export function getNavigationTheme(mode: ResolvedMode): Theme {
  const base = mode === "dark" ? DarkTheme : DefaultTheme;
  const c = colors[mode];
  return {
    ...base,
    dark: mode === "dark",
    colors: {
      ...base.colors,
      primary: c.primary,
      background: c.background,
      card: c.card,
      text: c.foreground,
      border: c.border,
      notification: c.destructive,
    },
  };
}
