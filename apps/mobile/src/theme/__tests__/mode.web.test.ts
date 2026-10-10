import { afterEach, describe, expect, it } from "@jest/globals";
import { Appearance } from "react-native";

import { applyThemeMode } from "../mode";

/**
 * react-native-web's `Appearance` has no `setColorScheme`; simulate that on the
 * native module so the guard is exercised without a web jest project.
 */
describe("applyThemeMode without Appearance.setColorScheme (web)", () => {
  const original = Appearance.setColorScheme;

  afterEach(() => {
    Appearance.setColorScheme = original;
  });

  it("does not throw when setColorScheme is undefined", () => {
    // @ts-expect-error simulate react-native-web, which lacks this method
    Appearance.setColorScheme = undefined;
    expect(() => applyThemeMode("dark")).not.toThrow();
    expect(() => applyThemeMode("system")).not.toThrow();
  });
});
