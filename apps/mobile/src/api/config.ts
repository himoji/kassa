import { env } from "@/lib/env";

/**
 * API origin from `EXPO_PUBLIC_API_URL` (e.g. `https://kassa.example` or
 * `http://192.168.1.20:4000`); every route lives under `/api` (spec §8). Unset on web means
 * same origin, which is how Caddy serves the web build next to `/api`.
 */
export function apiBaseUrl(origin: string | undefined = env.API_URL): string {
  const base = (origin ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
  return `${base}/api`;
}
