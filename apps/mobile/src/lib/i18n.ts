/**
 * i18n on i18next + react-i18next (i18n/i18next module).
 *
 * Two key styles live side by side:
 * - Kassa screens use namespaced keys, always fully qualified: `t("home:balance.title")` via
 *   `useKassaT()` / `i18next.t`. One JSON file per namespace in `src/locales/<lang>/<ns>.json`
 *   (ISO 639-1 language folders, BCP 47 tags at runtime).
 * - The boilerplate kit keeps its sentence keys ("Privacy policy") in the default `translation`
 *   namespace (`src/locales/<lang>/kit.json`), reached through `i18n.t` / `useT()`, which turn
 *   the separators off per call.
 * Kassa ships English, Simplified Chinese, Russian and Kazakh (Cyrillic). Add a locale by adding
 * `src/locales/<lang>/` and registering it in `LANGUAGES`, `LANGUAGE_LABELS` + `resources` below
 * (and `RTL_LANGUAGES` for a right-to-left script); `locales.test.ts` checks it has exactly the
 * English keys, placeholders and the plural forms its language needs. Missing keys fall back to
 * English, then to the key itself.
 *
 * Right-to-left: picking Arabic (any `RTL_LANGUAGES` entry) flips the whole layout through
 * `I18nManager.forceRTL` and restarts the app, which is how React Native applies a new
 * direction. Expo Go resets the direction when it opens a project - check RTL in a dev build.
 *
 * The device (or browser) language is the default, English when none of its preferred languages
 * is supported; a user override is persisted through the storage adapter under
 * `readynative:language`. Removing the override ("Device language" in Settings) follows the
 * device again.
 *
 * Web is statically rendered in Node, so the first client render uses English like the server
 * HTML did, and the provider switches to the stored or browser language after hydration.
 */
import { reloadAppAsync } from "expo";
import { getLocales } from "expo-localization";
import { createInstance } from "i18next";
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import { I18nManager, Platform } from "react-native";

import { storage } from "@/lib/storage";
import { en } from "@/locales/en";
import { kk } from "@/locales/kk";
import { ru } from "@/locales/ru";
import { zh } from "@/locales/zh";

export type I18nVars = Record<string, string | number>;

export type TFn = (key: string, vars?: I18nVars) => string;

export interface I18n {
  t: TFn;
}

export const LANGUAGES = ["en", "zh", "ru", "kk"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";
/** Native names for the language picker (never translated). */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  zh: "简体中文",
  ru: "Русский",
  kk: "Қазақша",
};

/** Languages written right-to-left: the layout mirrors when one is active. */
export const RTL_LANGUAGES: readonly Language[] = [];

const STORAGE_KEY = "readynative:language";

const resources = {
  en,
  zh,
  ru,
  kk,
} satisfies Record<Language, Record<string, unknown>>;

/** Kassa namespaces (one JSON file each); `translation` is the kit's sentence-key namespace. */
export const NAMESPACES = Object.keys(en) as (keyof typeof en)[];

/** Per-call options that make the kit's sentence keys ("Version {{version}}") literal lookups. */
const KIT_OPTIONS = { ns: "translation", keySeparator: false, nsSeparator: false } as const;

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
    if (typeof document !== "undefined") {
      document.documentElement.dir = rtl ? "rtl" : "ltr";
      document.documentElement.lang = language;
    }
    return false;
  }
  if (I18nManager.isRTL === rtl) return false;
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  return true;
}

/**
 * The first supported language in the device's (browser's) preference order, otherwise
 * `DEFAULT_LANGUAGE`. Every Chinese tag maps to the Simplified Chinese strings.
 */
export function deviceLanguage(): Language {
  for (const locale of getLocales()) {
    const code = locale.languageCode?.toLowerCase();
    if (isLanguage(code)) return code;
  }
  return DEFAULT_LANGUAGE;
}

/** Whether the user picked a language (`true`) or the app follows the device (`false`). */
let overridden = false;
const overrideListeners = new Set<() => void>();

function setOverridden(value: boolean): void {
  if (overridden === value) return;
  overridden = value;
  for (const listener of overrideListeners) listener();
}

/**
 * Persisted override (sync adapters only) or the device language. Without a sync read (web),
 * English: the static HTML was rendered with it, and `I18nProvider` switches after hydration.
 */
function initialLanguage(): Language {
  if (!storage.getItemSync) return DEFAULT_LANGUAGE;
  try {
    const stored = storage.getItemSync(STORAGE_KEY);
    if (isLanguage(stored)) {
      overridden = true;
      return stored;
    }
  } catch (err) {
    console.warn("[i18n] getItemSync failed", err);
  }
  return deviceLanguage();
}

/** The app instance; also registered with react-i18next for `useTranslation()`. */
export const i18next = createInstance();

i18next.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  ns: NAMESPACES,
  defaultNS: "translation",
  keySeparator: ".",
  nsSeparator: ":",
  interpolation: { escapeValue: false },
  // Resources are bundled: initialise synchronously so `t` works from the first render.
  initAsync: false,
});

export const i18n: I18n = {
  t: (key, vars) => i18next.t(key, { ...vars, ...KIT_OPTIONS }),
};

/** Kit sentence-key `t` bound to the current language; components re-render when it changes. */
export function useT(): TFn {
  const { t } = useTranslation();
  return useCallback<TFn>((key, vars) => t(key, { ...vars, ...KIT_OPTIONS }), [t]);
}

/**
 * Kassa `t` for fully qualified namespaced keys (`"order:approve"`), re-rendering on language
 * change. Options pass through to i18next (`count` for plurals, interpolation vars).
 */
export function useKassaT(): TFn {
  const { t } = useTranslation(NAMESPACES);
  return useCallback<TFn>((key, vars) => t(key, vars) as string, [t]);
}

/** The active BCP 47 locale tag for Intl formatting (money, dates). */
export function useLocaleTag(): string {
  const { i18n: instance } = useTranslation();
  return localeTag(instance.language);
}

/**
 * BCP 47 tag for Intl: the device's full tag (e.g. `en-GB`) when its language matches the UI
 * language, so number and date conventions follow the region; otherwise the bare language.
 */
export function localeTag(language: string = i18next.language): string {
  const device = getLocales()[0];
  if (device?.languageTag && device.languageCode === language) return device.languageTag;
  return language || DEFAULT_LANGUAGE;
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

async function forget(): Promise<void> {
  if (storage.removeItemSync) {
    try {
      storage.removeItemSync(STORAGE_KEY);
      return;
    } catch (err) {
      console.warn("[i18n] removeItemSync failed, falling back to async", err);
    }
  }
  await storage.removeItem(STORAGE_KEY).catch((err: unknown) => {
    console.warn("[i18n] forget failed", err);
  });
}

async function switchTo(language: Language): Promise<void> {
  await i18next.changeLanguage(language);
  if (applyDirection(language)) {
    await reloadAppAsync("Layout direction changed").catch((err: unknown) => {
      console.warn("[i18n] restart failed - the new direction applies on next launch", err);
    });
  }
}

/**
 * Switch language and persist the override through the storage adapter. Crossing between
 * left-to-right and right-to-left restarts the app so the whole layout mirrors.
 */
export async function setLanguage(language: Language): Promise<void> {
  setOverridden(true);
  await persist(language);
  await switchTo(language);
}

/** Drop the override and follow the device (browser) language again. */
export async function followDeviceLanguage(): Promise<void> {
  setOverridden(false);
  await forget();
  await switchTo(deviceLanguage());
}

/** The Settings choice: `"system"` while following the device, else the picked language. */
export type LanguagePreference = Language | "system";

function subscribeOverride(listener: () => void): () => void {
  overrideListeners.add(listener);
  return () => {
    overrideListeners.delete(listener);
  };
}

/** Current preference, reactive (re-renders on language change and on override changes). */
export function useLanguagePreference(): LanguagePreference {
  const language = useLanguage();
  const isOverridden = useSyncExternalStore(
    subscribeOverride,
    () => overridden,
    () => false
  );
  return isOverridden ? language : "system";
}

/** Apply a Settings choice. */
export function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  return preference === "system" ? followDeviceLanguage() : setLanguage(preference);
}

/**
 * Provider (order 60). i18next is initialised at import time; on adapters without a sync read
 * (web) this applies the persisted override, or else the browser language, after hydration.
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
        if (cancelled) return;
        if (isLanguage(stored)) setOverridden(true);
        const language = isLanguage(stored) ? stored : deviceLanguage();
        applyDirection(language);
        if (language !== i18next.language) return i18next.changeLanguage(language);
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
