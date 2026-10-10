/**
 * No-op privacy consent (contract 5). Replaced by the consent module.
 *
 * Without the module nothing asks: an undecided category reads as consented, so
 * the analytics / crash SDKs start as they would without the contract. What the
 * user did say is still honoured - "Do not sell or share" (Settings → Privacy,
 * shown whenever an analytics module is selected) and any explicit `false` in
 * the core store (`@/stores/consent`), which a later `--consent consent` run
 * keeps as well.
 */
import { useMemo } from "react";

import {
  consentStore,
  markConsentPrompted,
  setConsent,
  setDoNotSell,
  useConsentState,
  type ConsentCategory,
  type ConsentState,
} from "@/stores/consent";

export type { ConsentCategory, ConsentState } from "@/stores/consent";

/** `ca` is Canada (ISO 3166-1), not California - the device cannot tell US states apart. */
export type ConsentRegion = "eu" | "uk" | "ch" | "ca" | "br" | "other" | "unknown";

export type ConsentChoices = Record<ConsentCategory, boolean>;

export interface Consent {
  /** Effective consent per category (never `null`: undecided resolves by region). */
  get(): ConsentChoices;
  /** Reactive form of `get()`. */
  useConsent(): ConsentChoices;
  /** Record a choice; SDK modules subscribe to the store and start / stop. */
  set(patch: Partial<ConsentChoices>): void;
  /** CCPA/CPRA "Do not sell or share"; while on, analytics reads as off. */
  setDoNotSell(value: boolean): void;
  /** `true` in a region that needs asking when the current `CONSENT_VERSION` is unanswered. */
  needsPrompt(): boolean;
  /** The prompt was answered or dismissed; do not show it again for this version. */
  markPrompted(): void;
  /** Where the device says it is (`unknown` when no locale has a region). */
  region(): ConsentRegion;
  /**
   * Show the consent sheet now, whatever the region and the stored answer (Settings →
   * Developer tools). Lasts until the sheet is answered; a no-op without the consent module.
   */
  reprompt(): void;
}

/** `false` here; the consent module exports `true` so Settings shows its toggles. */
export const consentEnabled = false;

/** The stored answer could not be read: keep everything off until it can (next launch). */
const UNKNOWN: ConsentChoices = { analytics: false, crash: false };

function resolve(state: ConsentState): ConsentChoices {
  if (consentStore.hydrationFailed()) return UNKNOWN;
  return { analytics: state.analytics !== false && !state.doNotSell, crash: state.crash !== false };
}

// SDK modules read `consent.get()` right after importing this; load the stored answer first.
consentStore.hydrate().catch((err: unknown) => {
  console.warn("[consent] hydrate failed", err);
});

export const consent: Consent = {
  get: () => resolve(consentStore.getState()),
  useConsent: () => {
    const state = useConsentState();
    return useMemo(() => resolve(state), [state]);
  },
  set: (patch) => setConsent(patch, "settings"),
  setDoNotSell: (value) => setDoNotSell(value),
  needsPrompt: () => false,
  markPrompted: () => markConsentPrompted("sheet"),
  region: () => "unknown",
  reprompt: () => {},
};
