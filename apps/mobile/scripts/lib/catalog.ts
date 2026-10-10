/**
 * Categories, options and presets - the single ordered source used by setup,
 * gen and doctor. Order matters: the first option of every category is its
 * default, and categories are processed (copied) in this order, `ui` first.
 */
export const CATALOG = {
  ui: ["nativewind4", "nativewind5", "tamagui", "unistyles", "stylesheet"],
  data: ["react-query", "apollo", "swr", "none"],
  state: ["zustand", "jotai", "none"],
  storage: ["kv-store", "mmkv", "async-storage"],
  forms: ["react-hook-form", "none"],
  i18n: ["i18next", "lingui", "none"],
  auth: ["supabase", "clerk", "better-auth", "none"],
  payments: ["revenuecat", "adapty", "stripe", "none"],
  analytics: ["posthog", "amplitude", "none"],
  crash: ["sentry", "none"],
  push: ["expo-notifications", "none"],
  backend: ["api-routes", "none"],
  onboarding: ["on", "off"],
  location: ["expo-location", "none"],
  widgets: ["expo-widgets", "none"],
  consent: ["consent", "none"],
  testing: ["jest", "none"],
} as const;

export type Category = keyof typeof CATALOG;
export type OptionOf<C extends Category> = (typeof CATALOG)[C][number];

export const CATEGORIES = Object.keys(CATALOG) as Category[];

export function isCategory(value: string): value is Category {
  return Object.prototype.hasOwnProperty.call(CATALOG, value);
}

export function isOption(category: Category, option: string): boolean {
  return (CATALOG[category] as readonly string[]).includes(option);
}

/** The "off" option of a category (`none` / `off`); `undefined` when every option is real. */
export function noneOption(category: Category): string | undefined {
  const options = CATALOG[category] as readonly string[];
  return options.find((o) => o === "none" || o === "off");
}

export type Selection = { [C in Category]: string };

export type PresetName = "minimal" | "default" | "saas";
export const PRESET_NAMES: PresetName[] = ["minimal", "default", "saas"];

/** Full selections; every category present so a preset never depends on defaults. */
export const PRESETS: Record<PresetName, Selection> = {
  minimal: {
    ui: "nativewind4",
    data: "none",
    state: "none",
    storage: "kv-store",
    forms: "none",
    i18n: "none",
    auth: "none",
    payments: "none",
    analytics: "none",
    crash: "none",
    push: "none",
    backend: "none",
    onboarding: "off",
    location: "none",
    widgets: "none",
    consent: "none",
    testing: "none",
  },
  default: {
    ui: "nativewind4",
    data: "react-query",
    state: "zustand",
    storage: "kv-store",
    forms: "react-hook-form",
    i18n: "i18next",
    auth: "none",
    payments: "none",
    analytics: "none",
    crash: "none",
    push: "none",
    backend: "none",
    onboarding: "on",
    location: "expo-location",
    widgets: "none",
    // No analytics / crash module, so nothing to ask about (see `consentFor`).
    consent: "none",
    testing: "jest",
  },
  saas: {
    ui: "nativewind4",
    data: "react-query",
    state: "zustand",
    storage: "kv-store",
    forms: "react-hook-form",
    i18n: "i18next",
    auth: "supabase",
    payments: "revenuecat",
    analytics: "posthog",
    crash: "sentry",
    push: "expo-notifications",
    backend: "api-routes",
    onboarding: "on",
    location: "expo-location",
    widgets: "expo-widgets",
    consent: "consent",
    testing: "jest",
  },
};

/**
 * The consent option a selection needs: the sheet only has something to ask when an
 * analytics or crash module is selected. Presets follow it; the resolver applies it
 * whenever `--consent` is not given explicitly (see `buildSelection`).
 */
export function consentFor(selection: Pick<Selection, "analytics" | "crash">): "consent" | "none" {
  return selection.analytics !== "none" || selection.crash !== "none" ? "consent" : "none";
}

/**
 * The consent option the interactive setup pre-selects once the analytics / crash answers
 * are in: what `buildSelection` (lib/resolve.ts) would pick (`consentFor`), unless
 * `--consent` was passed. Without it the prompt defaulted to the previous answer (`none` in
 * the committed tree), so pressing Enter after picking PostHog or Sentry shipped them with
 * no consent sheet. `undefined` when the suggestion is not in this tree.
 */
export function suggestedConsent(
  selection: Pick<Selection, "analytics" | "crash">,
  available: (option: string) => boolean,
  explicit?: string
): string | undefined {
  if (explicit !== undefined) return explicit;
  const suggested = consentFor(selection);
  return available(suggested) ? suggested : undefined;
}

export function isPresetName(value: string): value is PresetName {
  return (PRESET_NAMES as string[]).includes(value);
}

/**
 * What a tree actually ships: which `modules/<category>/<option>` dirs exist in it.
 * A `Registry` satisfies this shape, and `scanOptions` builds a cheap one from dir
 * names alone. Buyer trees are assembled per tier, so never assume the full CATALOG.
 */
export interface OptionIndex {
  byCategory: ReadonlyMap<Category, ReadonlyMap<string, unknown>>;
}

export function hasOption(index: OptionIndex, category: Category, option: string): boolean {
  return index.byCategory.get(category)?.has(option) ?? false;
}

/** Options of `category` present in the tree, in catalog order. */
export function presentOptions(index: OptionIndex, category: Category): string[] {
  return (CATALOG[category] as readonly string[]).filter((o) => hasOption(index, category, o));
}

/** Presets whose every category option exists in the tree. */
export function availablePresets(index: OptionIndex): PresetName[] {
  return PRESET_NAMES.filter((name) =>
    CATEGORIES.every((c) => hasOption(index, c, PRESETS[name][c]))
  );
}

/** Categories worth asking about: at least two options present (else there is no choice). */
export function choosableCategories(index: OptionIndex): Category[] {
  return CATEGORIES.filter((c) => presentOptions(index, c).length >= 2);
}

/** First option per category. */
export function defaultSelection(): Selection {
  const out = {} as Selection;
  for (const c of CATEGORIES) out[c] = CATALOG[c][0];
  return out;
}

/** Name of the preset whose selection equals `selection`, else null. */
export function matchPreset(selection: Selection): PresetName | null {
  for (const name of PRESET_NAMES) {
    const preset = PRESETS[name];
    if (CATEGORIES.every((c) => preset[c] === selection[c])) return name;
  }
  return null;
}

/**
 * Dependencies of the core tree: every `dependencies` / `devDependencies` key of the root
 * package.json that no `default`-preset module declares. `removeDependencies` never touches
 * them, so a module may (re)declare a core package (`expo-device`, `expo-constants`, …) and
 * switching that module off leaves the core intact. Regenerate when the root package.json
 * changes (a test asserts every entry still exists there).
 */
export const CORE_DEPENDENCIES: ReadonlySet<string> = new Set([
  "@clack/prompts",
  "@expo/ui",
  "@types/node",
  "@types/react",
  "eslint",
  "eslint-config-expo",
  "eslint-config-prettier",
  "eslint-plugin-prettier",
  "expo",
  "expo-clipboard",
  "expo-constants",
  "expo-dev-client",
  "expo-device",
  "expo-file-system",
  "expo-font",
  "expo-glass-effect",
  "expo-haptics",
  "expo-image",
  "expo-linking",
  "expo-router",
  "expo-sharing",
  "expo-splash-screen",
  "expo-status-bar",
  "expo-store-review",
  "expo-symbols",
  "expo-system-ui",
  "expo-updates",
  "expo-web-browser",
  "prettier",
  "react",
  "react-dom",
  "react-native",
  "react-native-gesture-handler",
  "react-native-reanimated",
  "react-native-safe-area-context",
  "react-native-screens",
  "react-native-web",
  "react-native-worklets",
  "sharp",
  "typescript",
  "zod",
]);
