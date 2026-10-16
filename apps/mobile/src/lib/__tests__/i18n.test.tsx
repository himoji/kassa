import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import { storage } from "@/lib/storage";

import {
  LANGUAGES,
  LANGUAGE_LABELS,
  deviceLanguage,
  i18n,
  i18next,
  isRTL,
  setLanguage,
  setLanguagePreference,
  useKassaT,
  useLanguage,
  useLanguagePreference,
  useT,
} from "../i18n";

/** The jest.setup mock of expo-localization (the module object i18n.ts calls into). */
const Localization = jest.requireMock<{ getLocales: () => unknown[] }>("expo-localization");

/** A locale registered at runtime, standing in for a `src/locales/<lang>.json` a buyer adds. */
const DE = { Settings: "Einstellungen", "Version {{version}}": "Version {{version}}" };

describe("i18n (i18next)", () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await act(async () => {
      await setLanguage("en");
    });
  });

  it("ships English, Simplified Chinese, Russian and Kazakh, with native labels", () => {
    expect(LANGUAGES).toEqual(["en", "zh", "ru", "kk"]);
    expect(LANGUAGE_LABELS).toEqual({
      en: "English",
      zh: "简体中文",
      ru: "Русский",
      kk: "Қазақша",
    });
  });

  it("picks the first supported device language, else English", () => {
    const locales = (codes: string[]) =>
      jest
        .spyOn(Localization, "getLocales")
        .mockReturnValue(
          codes.map((languageCode) => ({ languageCode, languageTag: languageCode })) as never
        );
    locales(["de", "ru"]);
    expect(deviceLanguage()).toBe("ru");
    locales(["zh"]);
    expect(deviceLanguage()).toBe("zh");
    locales(["de", "fr"]);
    expect(deviceLanguage()).toBe("en");
    locales([]);
    expect(deviceLanguage()).toBe("en");
  });

  it("translates namespaced keys and plurals per language", async () => {
    const { result } = await renderHook(() => useKassaT());
    await act(async () => {
      await setLanguage("ru");
    });
    expect(result.current("settings:languageLabel")).toBe("Язык");
    expect(result.current("home:daysLeft", { count: 1 })).toBe("Остался 1 день");
    expect(result.current("home:daysLeft", { count: 3 })).toBe("Осталось 3 дня");
    expect(result.current("home:daysLeft", { count: 5 })).toBe("Осталось 5 дней");
    await act(async () => {
      await setLanguage("zh");
    });
    expect(result.current("home:daysLeft", { count: 1 })).toBe("还剩 1 天");
    await act(async () => {
      await setLanguage("kk");
    });
    expect(result.current("settings:languageLabel")).toBe("Тіл");
  });

  it("the device-language preference drops the override", async () => {
    const { result } = await renderHook(() => useLanguagePreference());
    await act(async () => {
      await setLanguagePreference("kk");
    });
    expect(result.current).toBe("kk");
    await expect(storage.getItem("readynative:language")).resolves.toBe("kk");

    await act(async () => {
      await setLanguagePreference("system");
    });
    expect(result.current).toBe("system");
    expect(i18next.language).toBe("en");
    await expect(storage.getItem("readynative:language")).resolves.toBeNull();
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
