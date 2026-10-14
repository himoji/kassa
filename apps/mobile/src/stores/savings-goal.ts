import { useEffect } from "react";

import { storage } from "@/lib/storage";

import { createPersistedStore } from "./create-store";

/**
 * The savings goal set on the "your rules" planner (and shown again in Settings → Budgets). On this device only:
 * a goal is a target to plan against, not a rule, so it is neither signed nor sent anywhere except for advice.
 */
export interface SavingsGoalState {
  amountMinor: number | null;
  months: number;
  currency: string | null;
}

const INITIAL: SavingsGoalState = { amountMinor: null, months: 6, currency: null };

export const savingsGoalStore = createPersistedStore<SavingsGoalState>({
  key: "kassa:savings-goal",
  initial: INITIAL,
  storage,
  parse: (raw) => {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== "object" || p === null) return undefined;
    const { amountMinor, months, currency } = p as Record<string, unknown>;
    if (typeof months !== "number" || !Number.isInteger(months) || months < 1) return undefined;
    return {
      amountMinor: typeof amountMinor === "number" && amountMinor > 0 ? amountMinor : null,
      months,
      currency: typeof currency === "string" ? currency : null,
    };
  },
});

export function setSavingsGoal(update: Partial<SavingsGoalState>): void {
  savingsGoalStore.setState(update);
}

/** The stored goal (loaded on first use). A goal saved in another currency does not apply. */
export function useSavingsGoal(currency: string): SavingsGoalState {
  useEffect(() => {
    void savingsGoalStore.hydrate();
  }, []);
  const state = savingsGoalStore.useStore();
  return state.currency && state.currency !== currency ? { ...INITIAL, currency } : state;
}
