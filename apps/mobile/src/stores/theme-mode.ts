import { useColorScheme } from "react-native";

import { storage } from "@/lib/storage";
import { applyThemeMode, resolveMode } from "@/theme/mode";
import type { ResolvedMode, ThemeMode } from "@/theme/tokens";

import { createPersistedStore } from "./create-store";

export interface ThemeModeState {
  mode: ThemeMode;
}

const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export const themeModeStore = createPersistedStore<ThemeModeState>({
  key: "readynative:theme-mode",
  initial: { mode: "system" },
  storage,
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "mode" in parsed &&
      isThemeMode(parsed.mode)
    ) {
      return { mode: parsed.mode };
    }
    return undefined;
  },
});

/** Persist the preference and apply it to `Appearance` immediately. */
export function setThemeMode(mode: ThemeMode): void {
  themeModeStore.setState({ mode });
  applyThemeMode(mode);
}

/** Load the persisted preference and apply it. Call once at app start. */
export async function hydrateThemeMode(): Promise<void> {
  await themeModeStore.hydrate();
  applyThemeMode(themeModeStore.getState().mode);
}

/** The user's preference (`system` | `light` | `dark`), not the effective scheme. */
export function useThemeMode(): ThemeMode {
  return themeModeStore.useStore((s) => s.mode);
}

/**
 * Effective scheme: the stored preference wins, `system` follows the OS.
 * Resolved from the store rather than `Appearance` alone so a forced mode is
 * reflected even before `Appearance` settles - and on web, where it never does.
 */
export function useResolvedMode(): ResolvedMode {
  const mode = useThemeMode();
  const systemScheme = useColorScheme();
  return resolveMode(mode, systemScheme);
}
