import { afterEach, describe, expect, it } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import { storage } from "@/lib/storage";

import {
  LANGUAGES,
  LANGUAGE_LABELS,
  i18n,
  i18next,
  isRTL,
  setLanguage,
  useLanguage,
  useT,
} from "../i18n";

/** A locale registered at runtime, standing in for a `src/locales/<lang>.json` a buyer adds. */
const DE = { Settings: "Einstellungen", "Version {{version}}": "Version {{version}}" };

describe("i18n (i18next)", () => {
  afterEach(async () => {
    await act(async () => {
      await setLanguage("en");
    });
  });

  it("ships English only, with a label", () => {
    expect(LANGUAGES).toEqual(["en"]);
    expect(LANGUAGE_LABELS).toEqual({ en: "English" });
  });

  it("has no right-to-left language", () => {
    expect(LANGUAGES.filter(isRTL)).toEqual([]);
  });

  it("starts in English and interpolates", () => {
    expect(i18n.t("Settings")).toBe("Settings");
    expect(i18n.t("Version {{version}}", { version: "2.0" })).toBe("Version 2.0");
  });

  it("returns the key for unknown strings", () => {
    expect(i18n.t("Not a known key")).toBe("Not a known key");
  });

  it("setLanguage persists the choice", async () => {
    const { result } = await renderHook(() => useLanguage());
    expect(result.current).toBe("en");

    await act(async () => {
      await setLanguage("en");
    });

    await expect(storage.getItem("readynative:language")).resolves.toBe("en");
  });

  it("a second registered locale switches translations and re-renders hooks", async () => {
    i18next.addResourceBundle("de", "translation", DE);
    const { result } = await renderHook(() => useT());
    expect(result.current("Settings")).toBe("Settings");

    try {
      await act(async () => {
        await i18next.changeLanguage("de");
      });

      expect(result.current("Settings")).toBe("Einstellungen");
      expect(result.current("Version {{version}}", { version: "2.0" })).toBe("Version 2.0");
      // Untranslated keys still fall back to English.
      expect(result.current("Appearance")).toBe("Appearance");
    } finally {
      await act(async () => {
        await i18next.changeLanguage("en");
      });
      i18next.removeResourceBundle("de", "translation");
    }
  });
});
