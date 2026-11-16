/* NovelTea's service worker: loads the app shell without a network.
 *
 * Hand-written on purpose — no workbox. Not bundled by Vite: tooling/offline-plugin.ts
 * emits it as /sw.js with the two placeholders below filled in, so the cache name
 * changes whenever the build does.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `noveltea-shell-${VERSION}`;

/**
 * What to do with a request. Kept pure so a test can pin it down.
 *   "ignore"     — not ours: the browser handles it untouched.
 *   "navigation" — network first, cached index.html when offline.
 *   "static"     — stale-while-revalidate.
 */
function route(method, mode, url, origin) {
  if (method !== "GET") return "ignore";
  const u = new URL(url);
  if (u.origin !== origin) return "ignore";
  // The API, and its health checks, are never ours to answer: a cached 200 from
  // /health/ready would claim a server that is not there.
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/health")) return "ignore";
  return mode === "navigate" ? "navigation" : "static";
}

self.addEventListener("install", (event) => {
  // Everything a cold offline start needs, including the lazily fetched sqlite wasm
  // and database worker, which a single visit would not necessarily have touched yet.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const kind = route(request.method, request.mode, request.url, self.location.origin);
  if (kind === "ignore") return;

  if (kind === "navigation") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Keep the newest shell, so the next offline start is this deploy's.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put("/index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const refresh = fetch(request).then((response) => {
        // Only complete 200s: a 206 or an error page must not become the cached file.
        if (response.status === 200) cache.put(request, response.clone());
        return response;
      });
      if (cached) {
        refresh.catch(() => {});
        return cached;
      }
      return refresh;
    }),
  );
});
