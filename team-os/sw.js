/* Minimal service worker — app-shell cache only. Network-first for API,
 * cache-first for static assets. Keeps the UI bootable when offline; the data
 * itself still requires the local backend.
 */
const CACHE_NAME = "teamos-shell-v1";
const SHELL_URLS = ["/", "/index.html"];

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
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Bypass API and Vite HMR
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/@") || url.pathname.includes("/__vite")) {
    return;
  }
  // Cache-first for shell + static
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ||
      fetch(event.request).then((res) => {
        const copy = res.clone();
        if (event.request.method === "GET" && res.status === 200) {
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("/index.html"))
    )
  );
});
