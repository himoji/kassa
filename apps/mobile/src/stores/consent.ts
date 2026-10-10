/**
 * Privacy consent (core store). `null` = the user has not decided yet; the
 * consent module (`@/lib/consent`) turns that into a yes/no per region.
 * Persisted under `readynative:consent` so the decision survives a local wipe
 * (`wipeLocalData` keeps this key).
 *
 * The record says which version of your consent text the answer was given to
 * (`version`), when it was first given (`decidedAt`), last changed
 * (`updatedAt`) and where (`source`). Raise `CONSENT_VERSION` when the sheet
 * asks for something new: every user in a prompt region is asked again.
 */
import { storage } from "@/lib/storage";

import { createPersistedStore } from "./create-store";

export type ConsentCategory = "analytics" | "crash";

/** Bump when the consent sheet's wording or purposes change; the sheet then asks again. */
export const CONSENT_VERSION = 1;

/** Where the answer came from. `legacy` = recorded before the record had a source. */
export type ConsentSource = "sheet" | "settings" | "do-not-sell" | "legacy";

export interface ConsentState {
  analytics: boolean | null;
  crash: boolean | null;
  /**
   * CCPA/CPRA "Do not sell or share my personal information". While `true`,
   * analytics reads as off whatever `analytics` says.
   */
  doNotSell: boolean;
  /** `CONSENT_VERSION` the answer was given to; `null` = never answered. */
  version: number | null;
  /** ISO date of the first answer (sheet or explicit toggle). */
  decidedAt: string | null;
  /** ISO date of the latest change. */
  updatedAt: string | null;
  source: ConsentSource | null;
}

const INITIAL: ConsentState = {
  analytics: null,
  crash: null,
  doNotSell: false,
  version: null,
  decidedAt: null,
  updatedAt: null,
  source: null,
};

const SOURCES: readonly ConsentSource[] = ["sheet", "settings", "do-not-sell", "legacy"];

const isChoice = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
const isDate = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Current shape, or the pre-record one (`{ analytics, crash, promptedAt }`), else `undefined`. */
export function parseConsent(raw: string): ConsentState | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const p = parsed as Record<string, unknown>;
  if (!isChoice(p.analytics) || !isChoice(p.crash)) return undefined;
  if ("version" in p) {
    const version = p.version;
    const source = p.source;
    if (version !== null && typeof version !== "number") return undefined;
    if (!isDate(p.decidedAt) || !isDate(p.updatedAt)) return undefined;
    if (source !== null && !SOURCES.includes(source as ConsentSource)) return undefined;
    return {
      analytics: p.analytics,
      crash: p.crash,
      doNotSell: p.doNotSell === true,
      version,
      decidedAt: p.decidedAt,
      updatedAt: p.updatedAt,
      source: source as ConsentSource | null,
    };
  }
  // Before the record: an answered prompt counts as version 1.
  if (!isDate(p.promptedAt)) return undefined;
  const at = p.promptedAt;
  return {
    analytics: p.analytics,
    crash: p.crash,
    doNotSell: false,
    version: at === null ? null : 1,
    decidedAt: at,
    updatedAt: at,
    source: at === null ? null : "legacy",
  };
}

export const consentStore = createPersistedStore<ConsentState>({
  key: "readynative:consent",
  initial: INITIAL,
  storage,
  parse: parseConsent,
});

function stamp(prev: ConsentState, source: ConsentSource, now: Date): Partial<ConsentState> {
  const at = now.toISOString();
  return {
    version: CONSENT_VERSION,
    decidedAt: prev.version === CONSENT_VERSION && prev.decidedAt ? prev.decidedAt : at,
    updatedAt: at,
    source,
  };
}

/**
 * Record one or both choices; an explicit choice counts as answered for the
 * current `CONSENT_VERSION`. Turning analytics on also lifts "Do not sell".
 */
export function setConsent(
  patch: Partial<Record<ConsentCategory, boolean>>,
  source: ConsentSource = "settings",
  now = new Date()
): void {
  consentStore.setState((prev) => ({
    ...patch,
    ...(patch.analytics === true ? { doNotSell: false } : {}),
    ...stamp(prev, source, now),
  }));
}

/** The sheet was answered or dismissed (with whatever choices were made). */
export function markConsentPrompted(source: ConsentSource = "sheet", now = new Date()): void {
  consentStore.setState((prev) => stamp(prev, source, now));
}

/** CCPA/CPRA opt-out of sale/sharing; persisted, and read by every consent option. */
export function setDoNotSell(value: boolean, now = new Date()): void {
  consentStore.setState((prev) => ({ doNotSell: value, ...stamp(prev, "do-not-sell", now) }));
}

export function useConsentState(): ConsentState {
  return consentStore.useStore();
}
