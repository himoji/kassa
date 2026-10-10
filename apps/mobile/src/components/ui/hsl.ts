/**
 * Hex → `H S% L%` triples for NativeWind 4's `hsl(var(--x) / <alpha-value>)`
 * colour scheme. Runtime twin of `scripts/lib/gen-theme-nativewind4.ts`: the
 * generator writes the same triples into `src/global.css`; `ForcedMode` needs
 * them at runtime to override a subtree via `vars()`.
 */
import { colors, cssColorVariables, type ResolvedMode } from "@/theme/tokens";

function expand(hex: string): string {
  return hex.length === 3 || hex.length === 4
    ? hex
        .split("")
        .map((c) => c + c)
        .join("")
    : hex;
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Alpha-composite `#rrggbbaa` onto an opaque backdrop; opaque input is returned as is. */
function flatten(hex: string, backdrop: string): string {
  const fg = expand(hex.replace(/^#/, ""));
  if (fg.length !== 8) return `#${fg}`;
  const bg = expand(backdrop.replace(/^#/, "")).slice(0, 6);
  const a = parseInt(fg.slice(6, 8), 16) / 255;
  const channel = (i: number) =>
    Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

/** `#171717` → `0 0% 9%`. Alpha is ignored (flatten first). */
export function hexToHslTriple(hex: string): string {
  const digits = expand(hex.replace(/^#/, "")).slice(0, 6);
  const r = parseInt(digits.slice(0, 2), 16) / 255;
  const g = parseInt(digits.slice(2, 4), 16) / 255;
  const b = parseInt(digits.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return `${fmt(h)} ${fmt(s * 100)}% ${fmt(l * 100)}%`;
}

/**
 * `--background`, `--card-foreground`, … → HSL triples for one mode, in the
 * shape `vars()` from `nativewind` expects. Mirrors the generated `src/global.css`.
 */
export function hslVariables(mode: ResolvedMode): Record<string, string> {
  const out: Record<string, string> = {};
  const backdrop = colors[mode].background;
  for (const [name, hex] of Object.entries(cssColorVariables(mode))) {
    out[name.replace(/^--color-/, "--")] = hexToHslTriple(flatten(hex, backdrop));
  }
  return out;
}
