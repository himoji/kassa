/**
 * Minimal persisted store on `useSyncExternalStore` (contract 3).
 *
 * No dependency on the state-management choice (zustand/jotai/none): built-in
 * stores (theme-mode, onboarding) and modules can rely on this regardless of
 * what the buyer selected.
 */
import { useSyncExternalStore } from "react";

import type { StorageAdapter } from "@/lib/storage-adapter";

export interface CreatePersistedStoreOptions<T> {
  /** Storage key, e.g. `readynative:theme-mode`. */
  key: string;
  initial: T;
  storage: StorageAdapter;
  /** Decode a stored string; throw or return `undefined` to keep `initial`. */
  parse?: (raw: string) => T | undefined;
  serialize?: (state: T) => string;
}

export type StoreListener = () => void;
export type StoreUpdater<T> = Partial<T> | ((prev: T) => Partial<T>);

export interface PersistedStore<T> {
  getState(): T;
  setState(update: StoreUpdater<T>): void;
  subscribe(listener: StoreListener): () => void;
  /** Read state in a component; `selector` must return a stable/primitive value. */
  useStore(): T;
  useStore<U>(selector: (state: T) => U): U;
  /**
   * Load persisted state. Uses `getItemSync` when the adapter has it (resolves
   * immediately), otherwise awaits `getItem`. Idempotent.
   */
  hydrate(): Promise<void>;
  /** `true` once `hydrate()` has completed (or nothing was stored). */
  isHydrated(): boolean;
  /**
   * `true` when the storage read itself failed (not "nothing stored"): the state is `initial`
   * but the persisted value is unknown. Nothing is written back; the next launch reads again.
   */
  hydrationFailed(): boolean;
  useHydrated(): boolean;
  /** Reset to `initial` and clear the persisted value. */
  reset(): void;
}

function defaultParse<T>(raw: string): T | undefined {
  return JSON.parse(raw) as T;
}

function defaultSerialize<T>(state: T): string {
  return JSON.stringify(state);
}

export function createPersistedStore<T extends object>(
  options: CreatePersistedStoreOptions<T>
): PersistedStore<T> {
  const { key, initial, storage } = options;
  const parse = options.parse ?? defaultParse<T>;
  const serialize = options.serialize ?? defaultSerialize<T>;

  let state: T = initial;
  let hydrated = false;
  let readFailed = false;
  let hydration: Promise<void> | null = null;
  /** `setState` ran; a later-resolving async hydrate must not clobber it. */
  let dirty = false;
  const listeners = new Set<StoreListener>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const getState = (): T => state;

  const persist = (next: T): void => {
    const raw = serialize(next);
    if (storage.setItemSync) {
      try {
        storage.setItemSync(key, raw);
        return;
      } catch (err) {
        console.warn(`[store:${key}] setItemSync failed, falling back to async`, err);
      }
    }
    storage.setItem(key, raw).catch((err: unknown) => {
      console.warn(`[store:${key}] persist failed`, err);
    });
  };

  const setState = (update: StoreUpdater<T>): void => {
    const patch = typeof update === "function" ? update(state) : update;
    const next = { ...state, ...patch };
    state = next;
    dirty = true;
    emit();
    persist(next);
  };

  const applyRaw = (raw: string | null): void => {
    if (raw === null) return;
    try {
      const parsed = parse(raw);
      if (parsed !== undefined) state = { ...initial, ...parsed };
    } catch (err) {
      console.warn(`[store:${key}] ignoring corrupt persisted value`, err);
    }
  };

  const finishHydration = (): void => {
    hydrated = true;
    emit();
  };

  const hydrate = (): Promise<void> => {
    if (hydration) return hydration;
    if (storage.getItemSync) {
      try {
        applyRaw(storage.getItemSync(key));
        finishHydration();
        hydration = Promise.resolve();
        return hydration;
      } catch (err) {
        console.warn(`[store:${key}] getItemSync failed, falling back to async`, err);
      }
    }
    // Async path (web: no sync kv-store). A `setState` that landed while
    // `getItem` was pending wins: keep the in-memory state and re-persist it so
    // storage matches even if its own write raced the read.
    hydration = storage
      .getItem(key)
      .then((raw) => {
        if (dirty) {
          persist(state);
          return;
        }
        applyRaw(raw);
      })
      .catch((err: unknown) => {
        readFailed = true;
        console.warn(`[store:${key}] hydrate failed`, err);
      })
      .then(finishHydration);
    return hydration;
  };

  const subscribe = (listener: StoreListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const isHydrated = (): boolean => hydrated;
  const hydrationFailed = (): boolean => readFailed && !dirty;

  function useStore(): T;
  function useStore<U>(selector: (s: T) => U): U;
  function useStore<U>(selector?: (s: T) => U): T | U {
    const getSnapshot = (): T | U => (selector ? selector(state) : state);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  const useHydrated = (): boolean => useSyncExternalStore(subscribe, isHydrated, isHydrated);

  const reset = (): void => {
    state = initial;
    emit();
    if (storage.removeItemSync) {
      try {
        storage.removeItemSync(key);
        return;
      } catch (err) {
        console.warn(`[store:${key}] removeItemSync failed, falling back to async`, err);
      }
    }
    storage.removeItem(key).catch((err: unknown) => {
      console.warn(`[store:${key}] reset failed`, err);
    });
  };

  return {
    getState,
    setState,
    subscribe,
    useStore,
    hydrate,
    isHydrated,
    hydrationFailed,
    useHydrated,
    reset,
  };
}
