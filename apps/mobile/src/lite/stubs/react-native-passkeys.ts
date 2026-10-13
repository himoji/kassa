/**
 * Metro alias for `react-native-passkeys` in the KassaLite build (metro.config.js, APP_VARIANT=lite):
 * the native module is excluded from autolinking there, and the real package throws on import when its
 * native half is missing. Lite approves in the web app (428 approveInWebApp), never with a passkey.
 */
export function isSupported(): boolean {
  return false;
}

export async function get(): Promise<null> {
  return null;
}

export async function create(): Promise<null> {
  return null;
}
