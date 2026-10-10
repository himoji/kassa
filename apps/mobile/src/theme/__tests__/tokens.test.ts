import { describe, expect, it } from "@jest/globals";
import readynative from "../../../readynative.config";
import { colors, cssColorVariables, radius, space } from "../tokens";

describe("theme tokens", () => {
  it("light and dark expose the same colour keys", () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  it("light primary comes from brand.primary", () => {
    expect(colors.light.primary).toBe(readynative.brand.primary);
  });

  it("radius derives from brand.radius", () => {
    const base = readynative.brand.radius;
    expect(radius.lg).toBe(base);
    expect(radius.md).toBe(base - 2);
    expect(radius.sm).toBe(base - 4);
    expect(radius.xl).toBe(base + 4);
    expect(radius.full).toBe(9999);
  });

  it("cssColorVariables maps tokens to the kebab-case --color-* names in global.css", () => {
    const vars = cssColorVariables("dark");
    expect(vars["--color-background"]).toBe(colors.dark.background);
    expect(vars["--color-card-foreground"]).toBe(colors.dark.cardForeground);
    expect(vars["--color-ring"]).toBe(colors.dark.ring);
    expect(vars["--color-destructive-foreground"]).toBe(colors.dark.destructiveForeground);
    expect(vars["--color-success"]).toBe(colors.dark.success);
    expect(Object.keys(vars)).toHaveLength(20);
    expect(vars).not.toHaveProperty("--color-brand-accent");
  });

  it("space scale is ascending", () => {
    const values = Object.values(space);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});
