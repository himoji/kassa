/**
 * "Apple Pay → Kassa" (iOS Shortcut Transaction automation, docs/SHORTCUT_SETUP.md): per-device bearer tokens
 * for POST /capture/shortcut (I13). The token is returned once by the server and never again; only its hash is
 * stored. These contracts are API-local (apps/api users/routes.ts), so their schemas live here.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

export const ShortcutDevicesResponse = z.object({
  devices: z.array(
    z.object({ id: z.string(), kind: z.literal("IOS_SHORTCUT"), createdAt: z.string() })
  ),
  lastCaptureAt: z.string().nullable(),
});
export type ShortcutDevices = z.infer<typeof ShortcutDevicesResponse>;

export const ShortcutTokenResponse = z.object({ deviceId: z.string(), token: z.string() });
export type ShortcutToken = z.infer<typeof ShortcutTokenResponse>;

export function useShortcutDevices() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.shortcutDevices,
    queryFn: ({ signal }) => api.request("/devices", { schema: ShortcutDevicesResponse, signal }),
    enabled: authed,
  });
}

/** POST /devices/shortcut: a new token, shown once. */
export function useCreateShortcutToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request("/devices/shortcut", { method: "POST", schema: ShortcutTokenResponse }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shortcutDevices }),
  });
}

/** DELETE /devices/:id: instant (a tightening); the token 401s from now on. */
export function useRevokeShortcutDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shortcutDevices }),
  });
}

/**
 * The URL the Shortcut posts to. `EXPO_PUBLIC_API_URL` when set; on web without it the API is same-origin
 * (Caddy / `bun run phone` proxy), so the page's own origin. Null when no absolute URL can be known.
 */
export function shortcutEndpoint(baseUrl: string = api.baseUrl, origin?: string): string | null {
  const path = `${baseUrl.replace(/\/+$/, "")}/capture/shortcut`;
  if (/^https?:\/\//i.test(path)) return path;
  const o =
    origin ??
    (typeof window !== "undefined" && window.location ? window.location.origin : undefined);
  if (!o || !/^https?:\/\//i.test(o)) return null;
  return `${o.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}
