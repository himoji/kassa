/**
 * What the "Log Payment in Kassa" action (plugins/log-payment-intent/LogPaymentIntent.swift) needs: the paired
 * server's origin and the Shortcut's bearer token, mirrored into one Keychain item the Swift side reads.
 *
 * A mirror, not the token item itself: that one is WHEN_UNLOCKED, and a Wallet Transaction automation can run while
 * the iPhone is still locked after an Apple Pay tap. This copy is AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (readable while
 * locked, once the phone has been unlocked after a restart; never in backups or on another device), the same
 * exposure as the key a hand-built Shortcut keeps in Shortcuts. The token only logs purchases.
 * Service and key are a contract with the Swift file (expo-secure-store adds ":no-auth" to the service).
 */
import * as SecureStore from "expo-secure-store";
import { Linking, Platform } from "react-native";

import { loadServerUrl } from "./server-url";
import { loadShortcutToken } from "./shortcut-token";

export const INTENT_CONFIG_KEY = "kassalite.intentConfig.v1";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: "kassalite.intent",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** The JSON the Swift intent decodes (`IntentConfig`). */
export function intentConfigJson(serverUrl: string, token: string): string {
  return JSON.stringify({ serverUrl, token });
}

/**
 * Write the intent's copy from the stored server and token. Best effort, and it never deletes: a token that cannot be
 * read right now (locked phone) must not wipe a working copy. Sign-out removes it (clearIntentConfig).
 */
export async function syncIntentConfig(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const [serverUrl, token] = await Promise.all([loadServerUrl(), loadShortcutToken()]);
    if (!serverUrl || !token) return;
    await SecureStore.setItemAsync(INTENT_CONFIG_KEY, intentConfigJson(serverUrl, token), OPTIONS);
  } catch {
    // The action then says KassaLite is not paired; the next launch tries again.
  }
}

export async function clearIntentConfig(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(INTENT_CONFIG_KEY, OPTIONS);
  } catch {
    // ignore
  }
}

/** Declared only by builds that contain the action (plugins/with-log-payment-intent.js `MARKER_SCHEME`). */
export const ACTION_MARKER_URL = "kassalite-log-payment://";

/**
 * Whether this build has the "Log Payment in Kassa" action. The JS can be newer than the build (over-the-air
 * updates), so it asks the native side: only builds with the action declare and may query the marker scheme.
 */
export async function hasLogPaymentAction(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await Linking.canOpenURL(ACTION_MARKER_URL);
  } catch {
    return false;
  }
}
