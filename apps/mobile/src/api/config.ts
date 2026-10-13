import { env } from "@/lib/env";

const isLoopback = (hostname: string) => /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(hostname);

/**
 * The API origin a fresh client uses: `EXPO_PUBLIC_API_URL`, except on a web page served from a
 * non-loopback host (the `bun run dev:all` tunnel, a LAN address) while the URL points at loopback
 * (`env:setup` writes `http://localhost:4000` to apps/mobile/.env, and in dev Expo's .env values win
 * over the shell env). That address is the visitor's own machine: unreachable from a phone, and a
 * cross-origin, cookie-less call (CORS / Private Network Access errors) from a desktop browser. Use
 * the page's own origin instead, where the proxy / Caddy serve `/api` next to the app.
 */
export function defaultApiOrigin(
  configured: string | undefined = env.API_URL,
  pageHostname: string | undefined = (globalThis as { location?: { hostname?: string } }).location
    ?.hostname
): string | undefined {
  if (!configured || !pageHostname || isLoopback(pageHostname)) return configured;
  try {
    return isLoopback(new URL(configured).hostname) ? undefined : configured;
  } catch {
    return configured;
  }
}

/**
 * API origin from `EXPO_PUBLIC_API_URL` (e.g. `https://kassa.example` or
 * `http://192.168.1.20:4000`); every route lives under `/api` (spec §8). Unset on web means
 * same origin, which is how Caddy serves the web build next to `/api`.
 */
export function apiBaseUrl(origin: string | undefined = defaultApiOrigin()): string {
  const base = (origin ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
  return `${base}/api`;
}
