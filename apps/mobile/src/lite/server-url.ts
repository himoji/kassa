/**
 * The server KassaLite talks to. The build has no fixed `EXPO_PUBLIC_API_URL`: pairing stores the
 * server's origin in the KV store and `applyServerUrl` points the shared API client at it.
 * HTTPS only (the Shortcut and iOS App Transport Security need a real certificate).
 */
import { api } from "@/api/client";
import { apiBaseUrl } from "@/api/config";
import { storage } from "@/lib/storage";

export const SERVER_URL_KEY = "kassalite:serverUrl";

/** `https://host[:port]` without path, query or trailing slash; null when not a valid https origin. */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!url.hostname || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return `https://${url.host}`;
  } catch {
    return null;
  }
}

export async function loadServerUrl(): Promise<string | null> {
  try {
    const stored = await storage.getItem(SERVER_URL_KEY);
    return stored ? normalizeServerUrl(stored) : null;
  } catch {
    return null;
  }
}

export async function saveServerUrl(url: string): Promise<void> {
  await storage.setItem(SERVER_URL_KEY, url);
}

export async function clearServerUrl(): Promise<void> {
  await storage.removeItem(SERVER_URL_KEY);
}

/** Point the API client at `serverUrl` (an origin) for this launch. */
export function applyServerUrl(serverUrl: string): void {
  api.setBaseUrl(apiBaseUrl(serverUrl));
}

/** `<origin>/api/capture/shortcut`: what the Shortcut posts to. */
export function shortcutEndpointFor(serverUrl: string): string {
  return `${apiBaseUrl(serverUrl)}/capture/shortcut`;
}
