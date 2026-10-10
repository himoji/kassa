/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";

import type { ThemeInput } from "../lib/gen-theme";
import {
  hexToHslTriple,
  renderNativewind4,
  renderNativewind4Css,
  renderNativewind4TailwindConfig,
} from "../lib/gen-theme-nativewind4";

const input: ThemeInput = {
  light: {
    "--color-background": "#ffffff",
    "--color-foreground": "#0a0a0a",
    "--color-primary": "#171717",
    "--color-primary-foreground": "#fafafa",
    "--color-destructive": "#e7000b",
    "--color-border": "#e5e5e5",
  },
  dark: {
    "--color-background": "#0a0a0a",
    "--color-foreground": "#fafafa",
    "--color-primary": "#e5e5e5",
    "--color-primary-foreground": "#171717",
    "--color-destructive": "#ff6467",
    "--color-border": "#ffffff1a",
  },
  radius: { sm: 8, md: 10, lg: 12 },
};

describe("gen-theme-nativewind4", () => {
  it("converts hex to H S% L% triples", () => {
    expect(hexToHslTriple("#ffffff")).toBe("0 0% 100%");
    expect(hexToHslTriple("#171717")).toBe("0 0% 9%");
    expect(hexToHslTriple("#e7000b")).toBe("357.1 100% 45.3%");
    expect(hexToHslTriple("#fff")).toBe("0 0% 100%");
    expect(() => hexToHslTriple("red")).toThrow(/hex colour/);
  });

  it("renders global.css with :root / .dark:root triples and radius vars", () => {
    const css = renderNativewind4Css(input);
    expect(css).toMatchSnapshot();
    expect(css.startsWith("@tailwind base;\n@tailwind components;\n@tailwind utilities;")).toBe(
      true
    );
    expect(css).toContain("  :root {\n    --background: 0 0% 100%;");
    expect(css).toContain("  .dark:root {\n    --background: 0 0% 3.9%;");
    expect(css).toContain("--radius: 12px;\n    --radius-md: 10px;\n    --radius-sm: 8px;");
  });

  it("flattens 8-digit hex onto the mode background and says so", () => {
    const css = renderNativewind4Css(input);
    expect(css).toContain("--border: 0 0% 13.7%; /* #ffffff1a flattened onto #0a0a0a */");
    expect(css).not.toContain("--border: 0 0% 100%;");
  });

  it("renders tailwind.config.js with hsl(var()) colours", () => {
    const config = renderNativewind4TailwindConfig(input);
    expect(config).toMatchSnapshot();
    expect(config).toContain('darkMode: "class"');
    expect(config).toContain('presets: [require("nativewind/preset")]');
    expect(config).toContain(
      'primary: {\n          DEFAULT: "hsl(var(--primary) / <alpha-value>)",\n          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",\n        },'
    );
    expect(config).toContain('border: "hsl(var(--border) / <alpha-value>)",');
    expect(config).toContain('lg: "var(--radius)"');
  });

  it("returns both artefacts keyed by module path", () => {
    expect(Object.keys(renderNativewind4(input))).toEqual([
      "modules/ui/nativewind4/files/src/global.css",
      "modules/ui/nativewind4/files/tailwind.config.js",
    ]);
  });
});
