/**
 * i18n on i18next + react-i18next (i18n/i18next module).
 *
 * Same surface as the core shim (`src/lib/shims/i18n.ts`): `i18n.t` for
 * plain functions, `useT()` for components (re-renders on language change).
 * Keys are the English source strings; `src/locales/<lang>.json` translate
 * them. Kassa ships English only; add a locale by dropping `src/locales/<lang>.json` and registering it in
 * `LANGUAGES`, `LANGUAGE_LABELS` + `resources` below (and `RTL_LANGUAGES` for a
 * right-to-left script). Missing keys fall back to English, then to the key itself.
 *
 * Right-to-left: picking Arabic (any `RTL_LANGUAGES` entry) flips the whole layout through
 * `I18nManager.forceRTL` and restarts the app, which is how React Native applies a new
 * direction. Expo Go resets the direction when it opens a project - check RTL in a dev build.
 *
 * The device language is the default; a user override is persisted through
 * the storage adapter under `readynative:language`.
 */
import { reloadAppAsync } from "expo";
import { getLocales } from "expo-localization";
import { createInstance } from "i18next";
import { useCallback, useEffect, type ReactNode } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import { I18nManager, Platform } from "react-native";

import { storage } from "@/lib/storage";
import en from "@/locales/en.json";

export type I18nVars = Record<string, string | number>;

export type TFn = (key: string, vars?: I18nVars) => string;

export interface I18n {
  t: TFn;
}

export const LANGUAGES = ["en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";
/** Native names for the language picker (never translated). */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
};

/** Languages written right-to-left: the layout mirrors when one is active. */
export const RTL_LANGUAGES: readonly Language[] = [];

const STORAGE_KEY = "readynative:language";

const resources = {
  en: { translation: en },
} satisfies Record<Language, { translation: Record<string, string> }>;

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function isRTL(language: Language): boolean {
  return RTL_LANGUAGES.includes(language);
}

/**
 * Point the layout direction at `language`. Native applies a new direction only after a
 * restart, so this reports whether one is needed; web flips `<html dir>` in place.
 */
function applyDirection(language: Language): boolean {
  const rtl = isRTL(language);
  if (Platform.OS === "web") {
    if (typeof document !== "undefined") document.documentElement.dir = rtl ? "rtl" : "ltr";
    return false;
  }
  if (I18nManager.isRTL === rtl) return false;
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  return true;
}

/** Device language when supported, otherwise `DEFAULT_LANGUAGE`. */
export function deviceLanguage(): Language {
  const code = getLocales()[0]?.languageCode;
  return isLanguage(code) ? code : DEFAULT_LANGUAGE;
}

/** Persisted override (sync adapters only) or the device language. */
function initialLanguage(): Language {
  if (storage.getItemSync) {
    try {
      const stored = storage.getItemSync(STORAGE_KEY);
      if (isLanguage(stored)) return stored;
    } catch (err) {
      console.warn("[i18n] getItemSync failed", err);
    }
  }
  return deviceLanguage();
}

/** The app instance; also registered with react-i18next for `useTranslation()`. */
export const i18next = createInstance();

i18next.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  // Keys are sentences ("Privacy policy", "Version {{version}}"): no namespaces or nesting.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  // Resources are bundled: initialise synchronously so `t` works from the first render.
  initAsync: false,
});

export const i18n: I18n = {
  t: (key, vars) => i18next.t(key, vars),
};

/** `t` bound to the current language; components re-render when it changes. */
export function useT(): TFn {
  const { t } = useTranslation();
  return useCallback<TFn>((key, vars) => t(key, vars), [t]);
}

/** Current language, reactive. */
export function useLanguage(): Language {
  const { i18n: instance } = useTranslation();
  return isLanguage(instance.language) ? instance.language : DEFAULT_LANGUAGE;
}

async function persist(language: Language): Promise<void> {
  if (storage.setItemSync) {
    try {
      storage.setItemSync(STORAGE_KEY, language);
      return;
    } catch (err) {
      console.warn("[i18n] setItemSync failed, falling back to async", err);
    }
  }
  await storage.setItem(STORAGE_KEY, language).catch((err: unknown) => {
    console.warn("[i18n] persist failed", err);
  });
}

/**
 * Switch language and persist the override through the storage adapter. Crossing between
 * left-to-right and right-to-left restarts the app so the whole layout mirrors.
 */
export async function setLanguage(language: Language): Promise<void> {
  await i18next.changeLanguage(language);
  await persist(language);
  if (applyDirection(language)) {
    await reloadAppAsync("Layout direction changed").catch((err: unknown) => {
      console.warn("[i18n] restart failed - the new direction applies on next launch", err);
    });
  }
}

/**
 * Provider (order 60). i18next is initialised at import time; this only
 * applies a persisted override on adapters without a sync read (web).
 */
export function I18nProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    // The direction a device-language default needs; takes effect on the next launch.
    if (storage.getItemSync) applyDirection(i18next.language as Language);
    if (storage.getItemSync) return;
    let cancelled = false;
    storage
      .getItem(STORAGE_KEY)
      .then((stored) => {
        if (!cancelled && isLanguage(stored) && stored !== i18next.language) {
          applyDirection(stored);
          return i18next.changeLanguage(stored);
        }
      })
      .catch((err: unknown) => {
        console.warn("[i18n] hydrate failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return children;
}
