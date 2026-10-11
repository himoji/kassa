/**
 * Web storage adapter: the browser's `localStorage` (HTML Living Standard §12.2.3 "The
 * localStorage getter").
 *
 * Native keeps `expo-sqlite/kv-store` (`./storage.ts`). On web that module runs SQLite in a Web
 * Worker over a SharedArrayBuffer: it needs Metro web-worker bundle splitting (which
 * `web.output: "static"` cannot serialise - "Worker chunk not found") and COOP/COEP headers on
 * every host, and expo-sqlite marks web support alpha. This app keeps a handful of small
 * preferences (language, theme, consent, onboarding ids), so web uses the platform store and the
 * SQLite worker never enters the web bundle.
 *
 * Async-only on purpose, like kv-store on web: static rendering runs in Node (no `window`), so a
 * sync read would paint stored values on the client that the server HTML never had (hydration
 * mismatch). Callers already hydrate through the async path on web.
 *
 * Keys are namespaced (`KEY_PREFIX`) so `keys()` / `clear()` ("Delete my data", sign-out) only see
 * and wipe this app's entries, never other scripts' data on the same origin.
 */
import type { StorageAdapter } from "@/lib/storage-adapter";

export type { StorageAdapter } from "@/lib/storage-adapter";

export const KEY_PREFIX = "kassa:kv:";

/**
 * The origin's `localStorage`, or `null` where there is none: static rendering in Node, or a
 * browser that blocks storage (the getter throws `SecurityError` when cookies are disabled).
 */
function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createLocalStorage(resolve: () => Storage | null = browserStorage): StorageAdapter {
  const ownKeys = (store: Storage): string[] => {
    const out: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(KEY_PREFIX)) out.push(key.slice(KEY_PREFIX.length));
    }
    return out;
  };
  return {
    getItem: async (key) => resolve()?.getItem(KEY_PREFIX + key) ?? null,
    // A full quota throws `QuotaExceededError`; it rejects the promise so callers' catch paths run.
    setItem: async (key, value) => {
      resolve()?.setItem(KEY_PREFIX + key, value);
    },
    removeItem: async (key) => {
      resolve()?.removeItem(KEY_PREFIX + key);
    },
    keys: async () => {
      const store = resolve();
      return store ? ownKeys(store) : [];
    },
    clear: async () => {
      const store = resolve();
      if (!store) return;
      for (const key of ownKeys(store)) store.removeItem(KEY_PREFIX + key);
    },
  };
}

export const storage: StorageAdapter = createLocalStorage();
