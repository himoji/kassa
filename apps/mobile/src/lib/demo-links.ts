/**
 * "Demo & proof" (Settings): the web pages a phone demo needs, on the server this app talks to. The web app, the
 * public evidence page and the mock world share one origin (Vercel rewrites /mock to the API function; `dev:all`'s
 * proxy serves /api and /mock next to the app), so every URL is built from the API base URL without `/api`.
 * Opened with `openUrl`: the in-app browser on the phone, a new tab on web.
 */

export type DemoLinkId = "evidence" | "ledger" | "stage" | "tap" | "wallet" | "till" | "school";

export interface DemoLink {
  id: DemoLinkId;
  path: string;
  /** A mock-world page: it exists only on a demo server (DEMO_ENABLED; the Stage is 404 otherwise). */
  mock: boolean;
  icon: string;
  fallback: string;
}

/** Order as shown. Ids are fixtures/seed-data.ts's: Budapest pizza shop "bud", school "budapest", student KZ26-0417. */
export const DEMO_LINKS: readonly DemoLink[] = [
  {
    id: "evidence",
    path: "/showcase/",
    mock: false,
    icon: "checkmark.shield",
    fallback: "verified_user",
  },
  { id: "ledger", path: "/showcase/#ledger", mock: false, icon: "link", fallback: "link" },
  {
    id: "stage",
    path: "/mock/stage",
    mock: true,
    icon: "theatermasks",
    fallback: "theater_comedy",
  },
  { id: "tap", path: "/mock/stage/tap", mock: true, icon: "wave.3.right", fallback: "contactless" },
  { id: "wallet", path: "/mock/stage/wallet", mock: true, icon: "qrcode", fallback: "qr_code_2" },
  { id: "till", path: "/mock/shop/bud/till", mock: true, icon: "cart", fallback: "point_of_sale" },
  {
    id: "school",
    path: "/mock/schools/budapest/portal?studentId=KZ26-0417",
    mock: true,
    icon: "graduationcap",
    fallback: "school",
  },
];

/**
 * The web origin for an API base URL: `https://x.example/api` → `https://x.example`. A relative base (`/api`, the
 * web app on its own origin) uses `pageOrigin`. Null when neither gives an http(s) origin.
 */
export function webOrigin(apiBaseUrl: string, pageOrigin?: string): string | null {
  const base = apiBaseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
  const origin = /^https?:\/\//i.test(base) ? base : (pageOrigin ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(origin)) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

/** The links to show, with absolute URLs. `mock: false` leaves out the mock-world pages (not a demo server). */
export function demoLinks(
  apiBaseUrl: string,
  opts: { mock: boolean; pageOrigin?: string }
): (DemoLink & { url: string })[] {
  const origin = webOrigin(apiBaseUrl, opts.pageOrigin);
  if (!origin) return [];
  return DEMO_LINKS.filter((l) => opts.mock || !l.mock).map((l) => ({
    ...l,
    url: `${origin}${l.path}`,
  }));
}
