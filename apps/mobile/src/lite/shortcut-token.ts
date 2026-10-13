/** The Shortcut's bearer token (POST /capture/shortcut), kept in the Keychain next to the session. */
import * as SecureStore from "expo-secure-store";

const KEY = "kassalite.shortcutToken.v1";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function loadShortcutToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY, OPTIONS);
  } catch {
    return null;
  }
}

export async function saveShortcutToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, token, OPTIONS);
}

export async function clearShortcutToken(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}
