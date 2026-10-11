/**
 * Native session tokens (spec §8: bearer JWT 15 min + refresh) in the platform keystore -
 * iOS Keychain / Android Keystore via expo-secure-store. Readable only while the device is
 * unlocked and never migrated to another device (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
 */
import * as SecureStore from "expo-secure-store";
import type { SessionTokens } from "@kassa/shared";

import type { TokenStore } from "./types";

const KEY = "kassa.session.v1";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cache: SessionTokens | null | undefined;

export const tokenStore: TokenStore = {
  kind: "native",
  async load() {
    if (cache !== undefined) return cache;
    try {
      const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
      cache = raw ? (JSON.parse(raw) as SessionTokens) : null;
    } catch (err) {
      console.warn("[session] could not read tokens", err);
      cache = null;
    }
    return cache;
  },
  async save(tokens) {
    cache = tokens;
    await SecureStore.setItemAsync(KEY, JSON.stringify(tokens), OPTIONS);
  },
  async clear() {
    cache = null;
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  },
};
