/*
 * Apps Холодосов service worker — app shell cache for bad connections.
 *  • static assets (_next/static, icons): cache-first (they are content-hashed)
 *  • pages under /m: network-first, fall back to the cached copy
 *  • GET /api/mobile/*: network-first, fall back to the last good answer (read-only data)
 *  • everything else (POST/PATCH, auth, KitShop — never): straight to the network
 * Offline mission actions are queued by the page itself (localStorage outbox), not here.
 */
const VERSION = "fo-v1";
const SHELL = ["/m", "/m/tasks", "/m/fridges", "/m/rating", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(req));
  } else if (url.pathname.startsWith("/api/mobile/")) {
    event.respondWith(networkFirst(req));
  } else if (req.mode === "navigate" && url.pathname.startsWith("/m")) {
    event.respondWith(networkFirst(req));
  }
});
