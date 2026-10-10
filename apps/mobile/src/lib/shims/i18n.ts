/**
 * No-op i18n (contract 5). Returns the key with `{{var}}` interpolation so
 * screens read the same with or without an i18n module.
 *
 * Keys are the English source strings, so this shim renders English as-is.
 * The i18n module (`src/lib/i18n.ts`) exposes the same `i18n.t` / `useT()`.
 */

export type I18nVars = Record<string, string | number>;

export type TFn = (key: string, vars?: I18nVars) => string;

export interface I18n {
  t: TFn;
}

export function interpolate(template: string, vars?: I18nVars): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export const i18n: I18n = {
  t: (key, vars) => interpolate(key, vars),
};

/** Hook form of `i18n.t`; the real module re-renders on language change, the shim never does. */
export function useT(): TFn {
  return i18n.t;
}

// Language surface, so Settings compiles with `--i18n none` (its picker hides for one language).
export const LANGUAGES = ["en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";
export const LANGUAGE_LABELS: Record<Language, string> = { en: "English" };

export function useLanguage(): Language {
  return DEFAULT_LANGUAGE;
}

export async function setLanguage(_language: Language): Promise<void> {}

/** Right-to-left script? The shim ships English only, so never. */
export function isRTL(_language: Language): boolean {
  return false;
}
