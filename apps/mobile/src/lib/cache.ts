/**
 * Offline cache: the last good response of anything, persisted through the storage adapter.
 *
 * Write every successful fetch with `cache.write(key, value)`; on the next launch - or with no
 * connection - `cache.read(key)` hands it back synchronously (kv-store / MMKV) so the screen
 * paints real content on the first frame, and `savedAt` says how old it is. Works with every
 * data module: TanStack Query takes it as `initialData` + `initialDataUpdatedAt`, SWR as
 * `fallbackData`, plain `useState` as its initial value.
 *
 * Entries live under `readynative:cache:<key>`, so "Delete my data" and sign-out wipe them
 * with everything else.
 */
import { storage as defaultStorage } from "@/lib/storage";
import type { StorageAdapter } from "@/lib/storage-adapter";

export interface Cached<T> {
  value: T;
  /** `Date.now()` when it was written. */
  savedAt: number;
}

export interface OfflineCache {
  /** The cached entry, synchronously; `null` when absent, unreadable, or the adapter is async-only. */
  read<T>(key: string): Cached<T> | null;
  /** Same, for async-only adapters (AsyncStorage, kv-store on web). */
  readAsync<T>(key: string): Promise<Cached<T> | null>;
  /** Stores `value` with the current time. Fire-and-forget: a failed write only logs. */
  write<T>(key: string, value: T): void;
  remove(key: string): void;
}

const PREFIX = "readynative:cache:";

function decode<T>(raw: string | null): Cached<T> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cached<T>>;
    return typeof parsed.savedAt === "number" && "value" in parsed
      ? { value: parsed.value as T, savedAt: parsed.savedAt }
      : null;
  } catch {
    return null;
  }
}

export function createOfflineCache(storage: StorageAdapter): OfflineCache {
  return {
    read<T>(key: string) {
      if (!storage.getItemSync) return null;
      try {
        return decode<T>(storage.getItemSync(PREFIX + key));
      } catch (err) {
        console.warn("[cache] read failed", err);
        return null;
      }
    },
    async readAsync<T>(key: string) {
      try {
        return decode<T>(await storage.getItem(PREFIX + key));
      } catch (err) {
        console.warn("[cache] read failed", err);
        return null;
      }
    },
    write<T>(key: string, value: T) {
      const raw = JSON.stringify({ value, savedAt: Date.now() } satisfies Cached<T>);
      if (storage.setItemSync) {
        try {
          storage.setItemSync(PREFIX + key, raw);
          return;
        } catch (err) {
          console.warn("[cache] setItemSync failed, falling back to async", err);
        }
      }
      storage.setItem(PREFIX + key, raw).catch((err: unknown) => {
        console.warn("[cache] write failed", err);
      });
    },
    remove(key: string) {
      storage.removeItem(PREFIX + key).catch((err: unknown) => {
        console.warn("[cache] remove failed", err);
      });
    },
  };
}

export const cache: OfflineCache = createOfflineCache(defaultStorage);
