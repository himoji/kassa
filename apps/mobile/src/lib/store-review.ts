/**
 * In-app review prompt on `expo-store-review`, gated by a small policy so the
 * app asks at a good moment instead of on launch.
 *
 * Call `trackSignificantEvent()` after a "win" (completed a task, finished a
 * purchase, …). Once enough events accrue, the cooldown has passed and the
 * lifetime cap is not reached, the native review sheet is requested. Disable
 * globally with `features.reviewPrompt: false` in `readynative.config.ts`.
 */
import * as StoreReview from "expo-store-review";
import { Linking, Platform } from "react-native";

import { crash } from "@/lib/crash";
import { readynative } from "@/lib/readynative";
import {
  markPrompted,
  recordSignificantEvent,
  reviewPromptStore,
  type ReviewPromptState,
} from "@/stores/review-prompt";

export const STORE_REVIEW_POLICY = {
  /** Events since the last prompt before asking again. */
  minSignificantEvents: 3,
  /** Days between prompts. */
  cooldownDays: 30,
  /** Lifetime cap; Apple/Google throttle far below this anyway. */
  maxPrompts: 3,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure policy check; `now` is injectable for tests. */
export function shouldPromptForReview(state: ReviewPromptState, now: number = Date.now()): boolean {
  if (state.promptCount >= STORE_REVIEW_POLICY.maxPrompts) return false;
  if (state.significantEvents < STORE_REVIEW_POLICY.minSignificantEvents) return false;
  if (state.lastPromptedAt !== null) {
    const elapsed = now - state.lastPromptedAt;
    if (elapsed < STORE_REVIEW_POLICY.cooldownDays * DAY_MS) return false;
  }
  return true;
}

/**
 * Shows the native review sheet when the policy allows it. Resolves `true` only
 * when `requestReview()` was actually called. Never throws.
 */
export async function requestReviewIfAppropriate(): Promise<boolean> {
  if (!readynative.features.reviewPrompt || __DEV__) return false;
  try {
    if (!shouldPromptForReview(reviewPromptStore.getState())) return false;
    if (!(await StoreReview.hasAction())) return false;
    await StoreReview.requestReview();
    markPrompted();
    return true;
  } catch (err) {
    crash.capture(err, { where: "store-review.requestReviewIfAppropriate" });
    return false;
  }
}

/** Record a significant event and prompt if appropriate. Safe to fire-and-forget. */
export function trackSignificantEvent(): Promise<boolean> {
  recordSignificantEvent();
  return requestReviewIfAppropriate();
}

/** Public store page from `readynative.config.ts` store ids; `null` when unset or on web. */
export function storeListingUrl(): string | null {
  if (Platform.OS === "ios") {
    const id = readynative.store.appStoreId;
    return id ? `https://apps.apple.com/app/id${id}` : null;
  }
  if (Platform.OS === "android") {
    const pkg = readynative.store.playPackage;
    return pkg ? `https://play.google.com/store/apps/details?id=${pkg}` : null;
  }
  return null;
}

/** Opens the store listing (config first, then `StoreReview.storeUrl()`); `false` when there is none. */
export async function openStoreListing(): Promise<boolean> {
  const url = storeListingUrl() ?? StoreReview.storeUrl();
  if (!url) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch (err) {
    crash.capture(err, { where: "store-review.openStoreListing", url });
    return false;
  }
}
