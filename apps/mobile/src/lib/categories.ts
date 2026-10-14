/**
 * Budget / mandate categories the app has labels for (`common:category.<id>`). Categories are
 * server-owned strings; unknown ones are shown as sent.
 */
export const KNOWN_CATEGORIES = [
  "groceries",
  "eating_out",
  "transport",
  "rent",
  "tuition",
  "insurance",
  "utilities",
  "shopping",
  "health",
  "other",
] as const;

/** Categories a standing mandate (autopay) makes sense for. */
export const MANDATE_CATEGORIES = [
  "rent",
  "tuition",
  "insurance",
  "utilities",
  "groceries",
] as const;

/** Categories offered when a budget is added by hand (any other name the user types becomes its own category). */
export const BUDGET_CATEGORIES = [
  ...KNOWN_CATEGORIES,
  "fun",
  "subscriptions",
  "travel",
  "phone",
  "sport",
  "beauty",
  "gifts",
  "pets",
] as const;

/** A typed category name as a category id ("Gym & sauna" → "gym_sauna"); null when nothing is left. */
export function categoryId(name: string): string | null {
  const id = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return id.length > 0 ? id : null;
}
