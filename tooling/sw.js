/* NovelTea's service worker: loads the app shell without a network.
 *
 * Hand-written on purpose — no workbox. Not bundled by Vite: tooling/offline-plugin.ts
 * writes it as /sw.js with the two placeholders below filled in, so the cache name
 * changes whenever the build does.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const PREFIX = "noveltea-shell-";
const CACHE = PREFIX + VERSION;
const NAV_TIMEOUT_MS = 4000;

/**
 * What to do with a request. Kept pure so a test can pin it down.
 *   "ignore"     — not ours: the browser handles it untouched.
 *   "navigation" — network first (with a timeout), cached index.html when offline.
 *   "static"     — stale-while-revalidate.
 */
function route(method, mode, url, origin, hasRange) {
  if (method !== "GET") return "ignore";
  // A cache holds whole files; a partial answer must come from the network.
  if (hasRange) return "ignore";
  const u = new URL(url);
  if (u.origin !== origin) return "ignore";
  // The API, and its health checks, are never ours to answer: a cached 200 from
  // /health/ready would claim a server that is not there.
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/health")) return "ignore";
  return mode === "navigate" ? "navigation" : "static";
}

/** nginx answers every app route with the shell, but a tab on /icons/x.png is not the shell. */
function isShell(contentType) {
  return (contentType || "").toLowerCase().startsWith("text/html");
}

/**
 * Which caches to delete on activate: everything but this build's and the one before it.
 * Why keep the previous one: skipWaiting makes the new worker control tabs still running
 * the old build, and those tabs keep asking for old hashed files (lazy fonts, db worker,
 * wasm). Without skipWaiting a fresh load would need every old tab closed first. So we take
 * over at once and leave the old files readable until the next deploy. keys() lists caches
 * in creation order, which is what makes "the one before" well defined.
 */
function staleCaches(keys, current) {
  const others = keys.filter((k) => k.startsWith(PREFIX) && k !== current);
  return others.slice(0, -1);
}

self.addEventListener("install", (event) => {
  // Everything a cold offline start needs, including index.html and the lazily fetched
  // sqlite wasm and database worker, which a single visit would not necessarily have
  // touched yet.
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
      .then((keys) => Promise.all(staleCaches(keys, CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ignoreVary: a precached copy was fetched without the Origin header that a module
// script sends, so a server answering "Vary: Origin" (vite preview does) would never match.
const MATCH = { ignoreVary: true };
const shell = () => caches.open(CACHE).then((c) => c.match("/index.html", MATCH));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const kind = route(
    request.method,
    request.mode,
    request.url,
    self.location.origin,
    request.headers.has("range"),
  );
  if (kind === "ignore") return;

  if (kind === "navigation") {
    const network = fetch(request).then(async (response) => {
      // Keep the newest shell, so the next offline start is this deploy's.
      if (response.ok && isShell(response.headers.get("content-type"))) {
        const cache = await caches.open(CACHE);
        await cache.put("/index.html", response.clone()).catch(() => {});
      }
      return response;
    });
    const settled = network.catch(() => null);
    // Keeps the worker alive for the cache write even when the timeout answered first.
    event.waitUntil(settled);
    const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS, null));
    event.respondWith(
      Promise.race([settled, timeout]).then(
        // Nothing cached yet: keep waiting for the network rather than fail.
        (response) => response ?? shell().then((cached) => cached ?? network),
      ),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Any generation will do on a miss: see staleCaches.
      const cached = (await cache.match(request, MATCH)) ?? (await caches.match(request, MATCH));
      const refresh = fetch(request).then(async (response) => {
        // Only complete 200s: a 206 or an error page must not become the cached file.
        if (response.status === 200) await cache.put(request, response.clone()).catch(() => {});
        return response;
      });
      event.waitUntil(refresh.catch(() => {}));
      return cached ?? refresh;
    })(),
  );
});
