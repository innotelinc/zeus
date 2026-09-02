/* Zeus VOIP Platform — PWA service worker.
 * Cache-first for static assets (icons/manifest/fonts), network-first for
 * pages and API calls, with an offline fallback to the landing page.
 * The version string busts the cache on every deploy. */
const VERSION = "zeus-v1";
const CORE_CACHE = `${VERSION}-core`;
const ASSET_CACHE = `${VERSION}-assets`;

const CORE_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/zeus-icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API calls and navigations: network-first, fall back to cache, then to "/".
  if (url.pathname.startsWith("/api/") || request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && url.pathname.startsWith("/api/")) {
            const clone = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offline = await caches.match("/");
          return offline ?? Response.error();
        }),
    );
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/"))) {
            const clone = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        }),
    ),
  );
});