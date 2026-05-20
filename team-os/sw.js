/* Team OS service worker — strictly scoped to same-origin static assets.
 *
 * v2 bug fix: the previous (v1) SW used cache-first for *every* GET, including
 * cross-origin requests to Supabase REST. That meant the first `select` from
 * teamos_tasks got cached and every subsequent refresh returned the stale copy
 * — new tasks created later were invisible until the user hard-reloaded.
 *
 * Now:
 *   - We only handle SAME-ORIGIN GETs. Cross-origin (Supabase, fonts, anything
 *     else) falls through to the network with no SW involvement.
 *   - index.html (and the root path) uses network-first so a fresh deploy
 *     replaces the cached shell on the next online load.
 *   - Hashed assets (/assets/*.js, /assets/*.css, /brand/*) use cache-first
 *     since their URLs already cache-bust on rebuild.
 *   - Stale caches from older versions are deleted on activate.
 */
const CACHE_NAME = "teamos-shell-v3";
const SHELL_URLS = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only intervene on same-origin GETs. Cross-origin (Supabase REST, realtime,
  // storage, fonts, etc.) goes straight to the network so we never cache it.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  const url = new URL(req.url);
  const isHashed = /\/assets\//.test(url.pathname) || /\.(?:woff2?|ttf|otf|png|jpg|jpeg|gif|webp|svg|ico)(?:\?|$)/.test(url.pathname) || /\/brand\//.test(url.pathname);

  if (isHashed) {
    // Cache-first for fingerprinted assets.
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached || new Response("offline", { status: 503 }))
      )
    );
    return;
  }

  // Network-first for HTML / everything else (manifest, sw, navigations) so new
  // deploys take effect on the next request without a hard reload.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.status === 200 && (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html"))) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});
