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
