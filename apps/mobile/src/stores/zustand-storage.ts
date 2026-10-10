/**
 * zustand `persist` storage on the app storage adapter (state/zustand module).
 * Prefers the sync API so native stores hydrate before first paint; falls back
 * to the async path (web).
 *
 * A persisted store looks like this (the only zustand-specific wiring is `storage`):
 *
 * ```ts
 * import { create } from "zustand";
 * import { createJSONStorage, persist } from "zustand/middleware";
 * import { zustandStorage } from "@/stores/zustand-storage";
 *
 * export const useCounterStore = create<{ count: number; increment: () => void }>()(
 *   persist(
 *     (set) => ({ count: 0, increment: () => set((s) => ({ count: s.count + 1 })) }),
 *     {
 *       name: "myapp:counter", // storage key
 *       storage: createJSONStorage(() => zustandStorage),
 *       partialize: (s) => ({ count: s.count }), // never persist functions
 *     }
 *   )
 * );
 * ```
 */
import type { StateStorage } from "zustand/middleware";

import { storage } from "@/lib/storage";

export const zustandStorage: StateStorage = {
  getItem: (name) => (storage.getItemSync ? storage.getItemSync(name) : storage.getItem(name)),
  setItem: (name, value) => {
    if (storage.setItemSync) {
      storage.setItemSync(name, value);
      return;
    }
    return storage.setItem(name, value);
  },
  removeItem: (name) => {
    if (storage.removeItemSync) {
      storage.removeItemSync(name);
      return;
    }
    return storage.removeItem(name);
  },
};
