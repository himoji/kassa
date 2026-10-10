/**
 * The consent categories this build actually has: `analytics` when an analytics
 * module is selected, `crash` when a crash module is. `bun setup` decides by
 * copying the module (or its no-op shim) in; nothing to edit here. The consent
 * sheet, the Settings toggles and "Do not sell or share" render only these.
 */
import { analyticsEnabled } from "@/lib/analytics";
import { crashEnabled } from "@/lib/crash";
import type { ConsentCategory } from "@/stores/consent";

export const privacyCategories: readonly ConsentCategory[] = [
  ...(analyticsEnabled ? (["analytics"] as const) : []),
  ...(crashEnabled ? (["crash"] as const) : []),
];
