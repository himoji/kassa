/** Theme-mode access through `@/components/ui`, so screens never import stores directly. */
export { setThemeMode, useResolvedMode, useThemeMode } from "@/stores/theme-mode";
export type { ResolvedMode, ThemeMode } from "@/theme/tokens";
