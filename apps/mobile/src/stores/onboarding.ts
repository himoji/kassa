import { storage } from "@/lib/storage";

import { createPersistedStore } from "./create-store";

export interface OnboardingState {
  completed: boolean;
}

export const onboardingStore = createPersistedStore<OnboardingState>({
  key: "readynative:onboarding",
  initial: { completed: false },
  storage,
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "completed" in parsed &&
      typeof parsed.completed === "boolean"
    ) {
      return { completed: parsed.completed };
    }
    return undefined;
  },
});

export function completeOnboarding(): void {
  onboardingStore.setState({ completed: true });
}

export function resetOnboarding(): void {
  onboardingStore.setState({ completed: false });
}

export function useOnboarding(): OnboardingState {
  return onboardingStore.useStore();
}
