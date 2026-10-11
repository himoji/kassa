/**
 * Active storage adapter: `expo-sqlite/kv-store` (storage/kv-store module), native only.
 * Web resolves `./storage.web.ts` (browser localStorage) instead, so the SQLite web worker
 * never enters the web bundle (see that file).
 *
 * The `StorageAdapter` interface lives in `@/lib/storage-adapter` (core);
 * this file only provides the implementation `bun setup` selected.
 */
import Storage from "expo-sqlite/kv-store";
import { Platform } from "react-native";

import type { StorageAdapter } from "@/lib/storage-adapter";

export type { StorageAdapter } from "@/lib/storage-adapter";

/**
 * Default adapter on `expo-sqlite/kv-store` (works in Expo Go).
 *
 * The sync API is only exposed on native: on web, sync SQLite needs a
 * SharedArrayBuffer worker (COOP/COEP headers) and throws otherwise, so web
 * callers always go through the async path. (The app's web build uses
 * `./storage.web.ts`; this branch only matters if this factory is imported there.)
 */
export function createKvStoreStorage(): StorageAdapter {
  const async: StorageAdapter = {
    getItem: (key) => Storage.getItemAsync(key),
    setItem: (key, value) => Storage.setItemAsync(key, value),
    removeItem: async (key) => {
      await Storage.removeItemAsync(key);
    },
    keys: () => Storage.getAllKeysAsync(),
    clear: async () => {
      await Storage.clearAsync();
    },
  };
  if (Platform.OS === "web") return async;
  return {
    ...async,
    getItemSync: (key) => Storage.getItemSync(key),
    setItemSync: (key, value) => {
      Storage.setItemSync(key, value);
    },
    removeItemSync: (key) => {
      Storage.removeItemSync(key);
    },
  };
}

export const storage: StorageAdapter = createKvStoreStorage();
