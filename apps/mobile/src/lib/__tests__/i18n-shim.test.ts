import { describe, expect, it } from "@jest/globals";
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  i18n,
  interpolate,
  setLanguage,
  useLanguage,
} from "../shims/i18n";

describe("i18n shim", () => {
  it("interpolates {{var}} placeholders", () => {
    expect(i18n.t("hello {{name}}", { name: "x" })).toBe("hello x");
  });

  it("returns the key unchanged without vars", () => {
    expect(i18n.t("hello {{name}}")).toBe("hello {{name}}");
  });

  it("leaves unknown placeholders intact and tolerates spaces", () => {
    expect(interpolate("{{ a }} and {{b}}", { a: 1 })).toBe("1 and {{b}}");
  });

  it("has a one-language surface so the Settings picker stays hidden", async () => {
    expect(LANGUAGES).toEqual(["en"]);
    expect(LANGUAGE_LABELS).toEqual({ en: "English" });
    expect(useLanguage()).toBe("en");
    await expect(setLanguage("en")).resolves.toBeUndefined();
  });
});
