import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import { storage } from "@/lib/storage";

import { completeOnboarding, onboardingStore, resetOnboarding, useOnboarding } from "../onboarding";

const KEY = "readynative:onboarding";

describe("onboarding store", () => {
  beforeEach(() => {
    onboardingStore.reset();
  });

  it("starts incomplete", () => {
    expect(onboardingStore.getState()).toEqual({ completed: false });
  });

  it("completeOnboarding sets completed and persists", async () => {
    const { result } = await renderHook(() => useOnboarding());
    await act(() => {
      completeOnboarding();
    });
    expect(result.current).toEqual({ completed: true });
    await expect(storage.getItem(KEY)).resolves.toBe(JSON.stringify({ completed: true }));
  });

  it("resetOnboarding clears completed", async () => {
    completeOnboarding();
    resetOnboarding();
    expect(onboardingStore.getState()).toEqual({ completed: false });
    await expect(storage.getItem(KEY)).resolves.toBe(JSON.stringify({ completed: false }));
  });

  it("hydrate ignores a malformed persisted value", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await storage.setItem(KEY, JSON.stringify({ completed: "yes" }));
    await onboardingStore.hydrate();
    expect(onboardingStore.getState()).toEqual({ completed: false });
    warn.mockRestore();
  });
});
