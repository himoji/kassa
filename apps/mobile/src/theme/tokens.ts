/**
 * Design-token source of truth.
 *
 * Pure data, importable from Node (unit tests, `scripts/gen-theme.ts`) - hence the
 * explicit `.ts` on the config import: node's type stripping resolves literal paths only.
 * Colour values mirror `src/global.css`; `gen-theme` regenerates the CSS from
 * this file, so edit tokens here, never in the CSS.
 */
import readynative from "../../readynative.config.ts";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedMode = "light" | "dark";

export type ColorToken =
  | "background"
  | "foreground"
  | "card"
  | "cardForeground"
  | "popover"
  | "popoverForeground"
  | "primary"
  | "primaryForeground"
  | "secondary"
  | "secondaryForeground"
  | "muted"
  | "mutedForeground"
  | "accent"
  | "accentForeground"
  | "destructive"
  | "destructiveForeground"
  | "success"
  | "border"
  | "input"
  | "ring"
  | "brandAccent";

export type ThemeColors = Readonly<Record<ColorToken, string>>;

const { brand } = readynative;

export const colors: Readonly<Record<ResolvedMode, ThemeColors>> = {
  light: {
    background: "#ffffff",
    foreground: "#0a0a0a",
    card: "#ffffff",
    cardForeground: "#0a0a0a",
    popover: "#ffffff",
    popoverForeground: "#0a0a0a",
    primary: brand.primary,
    primaryForeground: "#fafafa",
    secondary: "#f5f5f5",
    secondaryForeground: "#171717",
    muted: "#f5f5f5",
    mutedForeground: "#737373",
    accent: "#f5f5f5",
    accentForeground: "#171717",
    destructive: "#e7000b",
    destructiveForeground: "#ffffff",
    success: "#16a34a",
    border: "#e5e5e5",
    input: "#e5e5e5",
    ring: "#a1a1a1",
    brandAccent: brand.accent,
  },
  dark: {
    background: "#0a0a0a",
    foreground: "#fafafa",
    card: "#171717",
    cardForeground: "#fafafa",
    popover: "#171717",
    popoverForeground: "#fafafa",
    primary: "#e5e5e5",
    primaryForeground: "#171717",
    secondary: "#262626",
    secondaryForeground: "#fafafa",
    muted: "#262626",
    mutedForeground: "#a1a1a1",
    accent: "#262626",
    accentForeground: "#fafafa",
    destructive: "#ff6467",
    destructiveForeground: "#ffffff",
    success: "#4ade80",
    border: "#ffffff1a",
    input: "#ffffff1a",
    ring: "#737373",
    brandAccent: brand.accent,
  },
};

/** Colour tokens that exist as `--color-*` variables in `src/global.css`. */
const CSS_COLOR_TOKENS: readonly Exclude<ColorToken, "brandAccent">[] = [
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "destructive",
  "destructiveForeground",
  "success",
  "border",
  "input",
  "ring",
];

function toKebab(token: string): string {
  return token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * `--color-*` variables (kebab-case, as in `src/global.css`) for one mode, in
 * the shape NativeWind's `VariableContextProvider` expects.
 */
export function cssColorVariables(mode: ResolvedMode): Record<`--color-${string}`, string> {
  const out: Record<`--color-${string}`, string> = {};
  for (const token of CSS_COLOR_TOKENS) out[`--color-${toKebab(token)}`] = colors[mode][token];
  return out;
}

/** Spacing scale in px (Tailwind-compatible steps). */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;
export type SpaceToken = keyof typeof space;

const baseRadius = Math.max(0, Math.round(brand.radius));

/** Corner radii in px, derived from `brand.radius` (= `lg`). */
export const radius = {
  sm: Math.max(0, baseRadius - 4),
  md: Math.max(0, baseRadius - 2),
  lg: baseRadius,
  xl: baseRadius + 4,
  full: 9999,
} as const;
export type RadiusToken = keyof typeof radius;

/** Font sizes in px. */
export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
} as const;
export type FontSizeToken = keyof typeof fontSize;

/** Line heights in px, keyed like `fontSize` (Tailwind defaults). */
export const lineHeight = {
  xs: 16,
  sm: 20,
  base: 24,
  lg: 28,
  xl: 28,
  "2xl": 32,
  "3xl": 36,
  "4xl": 40,
} as const satisfies Record<FontSizeToken, number>;

/** RN `fontWeight` string values. */
export const fontWeight = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
} as const;
export type FontWeightToken = keyof typeof fontWeight;

export const fontFamily = brand.font;

export const tokens = {
  colors,
  space,
  radius,
  fontSize,
  lineHeight,
  fontWeight,
  fontFamily,
} as const;
