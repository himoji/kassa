/* Kassa service worker: app-shell cache for installable (Add to Home Screen) web builds.
 * Bump VERSION to invalidate every cache on the next activate. */
const VERSION = "kassa-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const CURRENT_CACHES = [SHELL_CACHE, STATIC_CACHE];

const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

const STATIC_PREFIXES = ["/_expo/static/", "/assets/", "/icons/", "/fonts/"];
const FONT_PATTERN = /\.(?:woff2?|ttf|otf)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !CURRENT_CACHES.includes(key)).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(path) {
  return STATIC_PREFIXES.some((prefix) => path.startsWith(prefix)) || FONT_PATTERN.test(path);
}

function networkFirstNavigation(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put("/", copy));
      }
      return response;
    })
    .catch(() => caches.match("/").then((cached) => cached || fetch(request)));
}

function cacheFirst(request) {
  return caches.open(STATIC_CACHE).then((cache) =>
    cache.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
    })
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API traffic is never cached: let the browser handle it (no respondWith).
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  // Standalone static pages (the evidence room) are not the app shell: never cache them as "/".
  if (url.pathname === "/showcase" || url.pathname.startsWith("/showcase/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});
