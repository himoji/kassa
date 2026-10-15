import { endSession } from "@/api/session";

import { clearIntentConfig } from "./intent-config";
import { clearNotifierState } from "./notifier";
import { clearDisplayName } from "./profile";
import { clearSetupProgress } from "./shortcut-check";
import { clearShortcutToken } from "./shortcut-token";

/** Sign out of KassaLite: revoke the refresh token (best effort), delete every token on this iPhone. */
export async function liteSignOut(): Promise<void> {
  await endSession();
  await clearShortcutToken();
  await clearIntentConfig();
  await clearDisplayName();
  await clearNotifierState();
  await clearSetupProgress();
}
