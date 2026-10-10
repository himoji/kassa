import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as StoreReview from "expo-store-review";
import { Linking, Platform } from "react-native";

import { readynative } from "@/lib/readynative";
import {
  STORE_REVIEW_POLICY,
  openStoreListing,
  requestReviewIfAppropriate,
  shouldPromptForReview,
  storeListingUrl,
  trackSignificantEvent,
} from "@/lib/store-review";
import { reviewPromptStore, type ReviewPromptState } from "@/stores/review-prompt";

jest.mock("expo-store-review", () => ({
  hasAction: jest.fn(async () => true),
  requestReview: jest.fn(async () => {}),
  storeUrl: jest.fn((): string | null => null),
}));

const hasAction = StoreReview.hasAction as jest.Mock<typeof StoreReview.hasAction>;
const requestReview = StoreReview.requestReview as jest.Mock<typeof StoreReview.requestReview>;
const storeUrl = StoreReview.storeUrl as jest.Mock<typeof StoreReview.storeUrl>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function state(patch: Partial<ReviewPromptState> = {}): ReviewPromptState {
  return { significantEvents: 0, lastPromptedAt: null, promptCount: 0, ...patch };
}

describe("shouldPromptForReview", () => {
  const min = STORE_REVIEW_POLICY.minSignificantEvents;

  it("needs enough significant events", () => {
    expect(shouldPromptForReview(state({ significantEvents: min - 1 }), NOW)).toBe(false);
    expect(shouldPromptForReview(state({ significantEvents: min }), NOW)).toBe(true);
  });

  it("respects the cooldown since the last prompt", () => {
    const cooldown = STORE_REVIEW_POLICY.cooldownDays * DAY;
    const recent = state({ significantEvents: min, lastPromptedAt: NOW - cooldown + 1 });
    const old = state({ significantEvents: min, lastPromptedAt: NOW - cooldown });
    expect(shouldPromptForReview(recent, NOW)).toBe(false);
    expect(shouldPromptForReview(old, NOW)).toBe(true);
  });

  it("stops at the lifetime cap", () => {
    const capped = state({ significantEvents: min, promptCount: STORE_REVIEW_POLICY.maxPrompts });
    expect(shouldPromptForReview(capped, NOW)).toBe(false);
  });
});

describe("requestReviewIfAppropriate", () => {
  const g = globalThis as unknown as { __DEV__: boolean };
  const originalDev = g.__DEV__;

  beforeEach(() => {
    g.__DEV__ = false;
    reviewPromptStore.reset();
    hasAction.mockClear();
    requestReview.mockClear();
    hasAction.mockImplementation(async () => true);
    requestReview.mockImplementation(async () => {});
  });

  afterEach(() => {
    g.__DEV__ = originalDev;
    jest.restoreAllMocks();
  });

  it("does nothing in __DEV__", async () => {
    g.__DEV__ = true;
    reviewPromptStore.setState({ significantEvents: 10 });
    await expect(requestReviewIfAppropriate()).resolves.toBe(false);
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("does nothing when features.reviewPrompt is off", async () => {
    jest.replaceProperty(readynative.features as { reviewPrompt: boolean }, "reviewPrompt", false);
    reviewPromptStore.setState({ significantEvents: 10 });
    await expect(requestReviewIfAppropriate()).resolves.toBe(false);
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("does nothing before the policy allows it", async () => {
    await expect(requestReviewIfAppropriate()).resolves.toBe(false);
    expect(hasAction).not.toHaveBeenCalled();
  });

  it("does nothing when the platform has no review action", async () => {
    hasAction.mockImplementation(async () => false);
    reviewPromptStore.setState({ significantEvents: 10 });
    await expect(requestReviewIfAppropriate()).resolves.toBe(false);
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("requests the review and marks the prompt", async () => {
    reviewPromptStore.setState({ significantEvents: STORE_REVIEW_POLICY.minSignificantEvents });
    await expect(requestReviewIfAppropriate()).resolves.toBe(true);
    expect(requestReview).toHaveBeenCalledTimes(1);
    const next = reviewPromptStore.getState();
    expect(next.promptCount).toBe(1);
    expect(next.significantEvents).toBe(0);
    expect(typeof next.lastPromptedAt).toBe("number");
  });

  it("swallows native errors", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    requestReview.mockImplementation(async () => {
      throw new Error("boom");
    });
    reviewPromptStore.setState({ significantEvents: 10 });
    await expect(requestReviewIfAppropriate()).resolves.toBe(false);
    expect(reviewPromptStore.getState().promptCount).toBe(0);
  });

  it("trackSignificantEvent counts up and prompts at the threshold", async () => {
    for (let i = 1; i < STORE_REVIEW_POLICY.minSignificantEvents; i++) {
      await expect(trackSignificantEvent()).resolves.toBe(false);
      expect(reviewPromptStore.getState().significantEvents).toBe(i);
    }
    await expect(trackSignificantEvent()).resolves.toBe(true);
    expect(requestReview).toHaveBeenCalledTimes(1);
  });
});

describe("store listing", () => {
  beforeEach(() => {
    // RN's jest setup already mocks `Linking.openURL`; clear its history between tests.
    jest.mocked(Linking.openURL).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    storeUrl.mockImplementation(() => null);
  });

  it("returns null without store ids", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    jest.replaceProperty(readynative.store, "appStoreId", "");
    expect(storeListingUrl()).toBeNull();
  });

  it("builds the App Store url on iOS", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    jest.replaceProperty(readynative.store, "appStoreId", "123456");
    expect(storeListingUrl()).toBe("https://apps.apple.com/app/id123456");
  });

  it("builds the Play Store url on Android", () => {
    jest.replaceProperty(Platform, "OS", "android");
    jest.replaceProperty(readynative.store, "playPackage", "com.acme.app");
    expect(storeListingUrl()).toBe("https://play.google.com/store/apps/details?id=com.acme.app");
  });

  it("returns null on web", () => {
    jest.replaceProperty(Platform, "OS", "web");
    jest.replaceProperty(readynative.store, "appStoreId", "123456");
    expect(storeListingUrl()).toBeNull();
  });

  it("openStoreListing opens the configured url", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    jest.replaceProperty(readynative.store, "appStoreId", "123456");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await expect(openStoreListing()).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledWith("https://apps.apple.com/app/id123456");
  });

  it("openStoreListing falls back to StoreReview.storeUrl and reports nothing to open", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    jest.replaceProperty(readynative.store, "appStoreId", "");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await expect(openStoreListing()).resolves.toBe(false);
    expect(openURL).not.toHaveBeenCalled();

    storeUrl.mockImplementation(() => "itms-apps://example");
    await expect(openStoreListing()).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledWith("itms-apps://example");
  });
});
