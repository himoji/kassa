/**
 * A lite session cannot sign with a passkey: approvals (and other passkey-gated writes) answer
 * HTTP 428 PASSKEY_REQUIRED with `details.approveInWebApp = <origin>`. KassaLite opens that page in the
 * in-app browser, where the person approves with their passkey. After an order approval the web app sends them back
 * to `kassalite://order/<id>` (order-sheet-screen, `from=lite`), which closes the browser by itself.
 *
 * `registerApproveInWebApp()` is wired once in the lite root layout through `onApiError`, so the chat
 * screen's approve action (api.request) needs no change. Streaming requests (`authorizedFetch`, the chat
 * stream itself) do not go through `onApiError`; a 428 there would have to call `openApproveInWebApp`.
 */
import * as WebBrowser from "expo-web-browser";

import { onApiError } from "@/api/client";
import { KassaApiError } from "@/api/errors";
import { moneyKeys } from "@/api/keys";
import { queryClient } from "@/lib/query";

/** The scheme the web app sends people back to after approving (`kassalite://order/<id>`, app.config.ts). */
export const LITE_RETURN_URL = "kassalite://";

/** The https URL to approve at, or null when `err` is not a lite approval refusal. */
export function approveInWebAppUrl(err: unknown): string | null {
  if (!(err instanceof KassaApiError) || err.status !== 428) return null;
  const details = err.details;
  if (typeof details !== "object" || details === null) return null;
  const url = (details as { approveInWebApp?: unknown }).approveInWebApp;
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
}

let lastOpenedAt = 0;

/** Open the approval page for a 428 `err`. Resolves true when a browser was opened. */
export async function openApproveInWebApp(
  err: unknown,
  now: number = Date.now()
): Promise<boolean> {
  const url = approveInWebAppUrl(err);
  if (!url) return false;
  // The same refusal can surface from several retries at once: one browser sheet is enough.
  if (now - lastOpenedAt < 3000) return true;
  lastOpenedAt = now;
  // An auth session closes by itself when the web app sends the person back to kassalite:// after approving.
  await WebBrowser.openAuthSessionAsync(url, LITE_RETURN_URL);
  // Back in KassaLite: show what changed (the approved order, balances, bills).
  await Promise.all(
    [["orders"], ...moneyKeys].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );
  return true;
}

export function registerApproveInWebApp(): () => void {
  return onApiError((err) => void openApproveInWebApp(err).catch(() => {}));
}
