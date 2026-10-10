/**
 * Storage adapter (contract 2).
 *
 * Built-in stores and every module talk to storage only through this
 * interface, so the backing store (kv-store / MMKV / AsyncStorage) can be
 * swapped by `bun setup` without touching callers. The active implementation
 * is `storage` from `@/lib/storage` (owned by the selected storage module).
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** Optional sync API; present when the backend can read without awaiting. */
  getItemSync?(key: string): string | null;
  setItemSync?(key: string, value: string): void;
  removeItemSync?(key: string): void;
  /**
   * Optional enumeration, used by `@/lib/privacy` to export and wipe local
   * data. Every shipped backend has it; a custom adapter may leave it out.
   */
  keys?(): Promise<string[]>;
  clear?(): Promise<void>;
}

/** In-memory adapter for unit tests. Exposes both sync and async APIs. */
export function createMemoryStorage(
  seed: Record<string, string> = {}
): StorageAdapter & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
    getItemSync: (key) => map.get(key) ?? null,
    setItemSync: (key, value) => {
      map.set(key, value);
    },
    removeItemSync: (key) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
    clear: async () => {
      map.clear();
    },
    dump: () => Object.fromEntries(map),
  };
}
