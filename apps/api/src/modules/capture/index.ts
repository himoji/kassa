export { ingestCapture, reconcileSettlement, rememberCategoryCorrection, setTransactionCategory, SettlementError, type CaptureInput } from "./service.ts";
export { normalizeMerchant } from "./normalize.ts";
export { dedupeKey, dedupeCandidates, bucketOf, BUCKET_MS } from "./dedupe.ts";
export { categorize, categoryFromMcc, lookupMerchant, loadMerchantDictionary } from "./categorize.ts";
export { parseNotificationText, parseShortcut, ShortcutPayload, TEXT_PARSERS } from "./parsers/index.ts";
