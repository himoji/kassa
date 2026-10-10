/**
 * Persisted counters behind the store-review prompt (`@/lib/store-review`).
 *
 * `significantEvents` is bumped by `trackSignificantEvent()`; the prompt policy
 * (`STORE_REVIEW_POLICY`) reads all three fields to decide whether asking is
 * appropriate. Platform quotas still apply on top - the OS may silently ignore
 * `requestReview()`.
 */
import { storage } from "@/lib/storage";

import { createPersistedStore } from "./create-store";

export interface ReviewPromptState {
  significantEvents: number;
  /** Epoch ms of the last `requestReview()` call, or `null` when never prompted. */
  lastPromptedAt: number | null;
  promptCount: number;
}

const INITIAL: ReviewPromptState = { significantEvents: 0, lastPromptedAt: null, promptCount: 0 };

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export const reviewPromptStore = createPersistedStore<ReviewPromptState>({
  key: "readynative:review-prompt",
  initial: INITIAL,
  storage,
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { significantEvents, lastPromptedAt, promptCount } = parsed as Record<string, unknown>;
    if (
      isNonNegativeInt(significantEvents) &&
      isNonNegativeInt(promptCount) &&
      (lastPromptedAt === null || isNonNegativeInt(lastPromptedAt))
    ) {
      return { significantEvents, lastPromptedAt, promptCount };
    }
    return undefined;
  },
});

export function recordSignificantEvent(): void {
  reviewPromptStore.setState((prev) => ({ significantEvents: prev.significantEvents + 1 }));
}

/** Called right after `StoreReview.requestReview()`; resets the event counter for the next cycle. */
export function markPrompted(now: number = Date.now()): void {
  reviewPromptStore.setState((prev) => ({
    significantEvents: 0,
    lastPromptedAt: now,
    promptCount: prev.promptCount + 1,
  }));
}

export function resetReviewPrompt(): void {
  reviewPromptStore.reset();
}

export function useReviewPrompt(): ReviewPromptState {
  return reviewPromptStore.useStore();
}
