/**
 * KassaLite's Shortcut setup check (docs/KASSALITE.md, "Shortcut setup"): the setup checklist's progress, a
 * connection check from the app itself (POST /capture/shortcut `{test: true}` with the Shortcut's own token: the
 * server and the token work from this iPhone; nothing is logged) and the link that runs the installed Shortcut
 * once (`shortcuts://x-callback-url/run-shortcut`; without a Transaction input it sends empty fields, which the
 * server answers as a test run and records as the device's `lastUsedAt`).
 */
import { storage } from "@/lib/storage";

import { shortcutEndpointFor } from "./server-url";

/** The name the Shortcut must have in the Shortcuts app (the template's name; the manual steps use it too). */
export const SHORTCUT_NAME = "Kassa";

/** Where Shortcuts sends the person back after the test run (KassaLite's Settings tab). */
export const SHORTCUT_RETURN_URL = "kassalite://settings";

export type SetupProgress = { copied: boolean; added: boolean; automated: boolean };

const PROGRESS_KEY = "kassalite:shortcutSetup.v1";
export const EMPTY_PROGRESS: SetupProgress = { copied: false, added: false, automated: false };

export async function loadSetupProgress(): Promise<SetupProgress> {
  try {
    const raw = await storage.getItem(PROGRESS_KEY);
    if (!raw) return EMPTY_PROGRESS;
    const parsed = JSON.parse(raw) as Partial<SetupProgress>;
    return {
      copied: parsed.copied === true,
      added: parsed.added === true,
      automated: parsed.automated === true,
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export async function saveSetupProgress(progress: SetupProgress): Promise<void> {
  try {
    await storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // A lost checkmark only costs a tap; the connection status comes from the server.
  }
}

export async function clearSetupProgress(): Promise<void> {
  try {
    await storage.removeItem(PROGRESS_KEY);
  } catch {
    // ignore
  }
}

/** `shortcuts://x-callback-url/run-shortcut?name=Kassa&x-success=…`: runs the Shortcut once and comes back. */
export function shortcutRunUrl(
  name: string = SHORTCUT_NAME,
  back: string = SHORTCUT_RETURN_URL
): string {
  const q = [
    `name=${encodeURIComponent(name)}`,
    `x-success=${encodeURIComponent(back)}`,
    `x-cancel=${encodeURIComponent(back)}`,
    `x-error=${encodeURIComponent(back)}`,
  ].join("&");
  return `shortcuts://x-callback-url/run-shortcut?${q}`;
}

export type ConnectionCheck = "ok" | "revoked" | "unreachable" | "failed";

/**
 * POST `{test: true}` to the Shortcut endpoint with the Shortcut's token, as the Shortcut would. "revoked": 401
 * (token revoked or from another server); "unreachable": no HTTPS answer (tunnel or Mac down, wrong host).
 */
export async function checkShortcutConnection(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000
): Promise<ConnectionCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(shortcutEndpointFor(serverUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
      signal: controller.signal,
    });
    if (res.status === 401) return "revoked";
    if (!res.ok) return "failed";
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return body?.status === "TEST" ? "ok" : "failed";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** True when `after` is a later instant than `before` (null `before`: any `after`). */
export function movedSince(after: string | null | undefined, before: string | null): boolean {
  if (!after) return false;
  if (!before) return true;
  return Date.parse(after) > Date.parse(before);
}
