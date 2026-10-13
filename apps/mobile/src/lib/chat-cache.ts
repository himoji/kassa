/**
 * Native offline cache of the latest chat messages. Content is encrypted at rest: AES-256-GCM
 * (expo-crypto) under a random 256-bit key that lives only in the Keychain / Keystore
 * (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`); the ciphertext (base64: nonce | data | tag) sits in the kv
 * store under `chat-cache:<conversationId>`. Web resolves `./chat-cache.web.ts` (a no-op): no
 * message content ever reaches localStorage.
 *
 * Every failure degrades to "no cache": the server history is the source of truth.
 */
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  getRandomBytes,
} from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { storage } from "@/lib/storage";

export const CHAT_CACHE_LIMIT = 50;
const KEY_PREFIX = "chat-cache:";
const SECURE_KEY = "kassa.chat-cache.key";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadKey(create: boolean): Promise<AESEncryptionKey | null> {
  let stored = await SecureStore.getItemAsync(SECURE_KEY);
  if (!stored) {
    if (!create) return null;
    stored = bytesToBase64(getRandomBytes(32));
    await SecureStore.setItemAsync(SECURE_KEY, stored, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  return AESEncryptionKey.import(base64ToBytes(stored));
}

export async function readCachedMessages<T = unknown>(conversationId: string): Promise<T[]> {
  try {
    const raw = await storage.getItem(KEY_PREFIX + conversationId);
    if (!raw) return [];
    const key = await loadKey(false);
    if (!key) return [];
    const plain = await aesDecryptAsync(AESSealedData.fromCombined(raw), key);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain as Uint8Array));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function writeCachedMessages(
  conversationId: string,
  messages: readonly unknown[]
): Promise<void> {
  try {
    const key = await loadKey(true);
    if (!key) return;
    const json = JSON.stringify(messages.slice(-CHAT_CACHE_LIMIT));
    const sealed = await aesEncryptAsync(new TextEncoder().encode(json), key);
    await storage.setItem(KEY_PREFIX + conversationId, await sealed.combined("base64"));
  } catch (err) {
    console.warn("[chat-cache] write failed", err);
  }
}

/** Sign-out / account erase: drop every cached conversation and the key itself. */
export async function clearChatCache(): Promise<void> {
  try {
    for (const k of (await storage.keys?.()) ?? []) {
      if (k.startsWith(KEY_PREFIX)) await storage.removeItem(k);
    }
  } catch (err) {
    console.warn("[chat-cache] clear failed", err);
  }
  try {
    await SecureStore.deleteItemAsync(SECURE_KEY);
  } catch (err) {
    console.warn("[chat-cache] key delete failed", err);
  }
}
