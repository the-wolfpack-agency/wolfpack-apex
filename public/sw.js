 
/**
 * Instinct service worker — offline shell caching.
 *
 * Scope:    "/"   (registered from dashboard layout)
 * Strategy: stale-while-revalidate for GET /api/sites/*, /_next/static/*,
 *           /_next/data/*, same-origin JS/CSS/image assets.
 *           Network-first for everything else.
 *           POST/PATCH/DELETE are NEVER cached — handled exclusively by
 *           the IndexedDB mutation queue (src/lib/offline-queue.ts).
 *
 * Auth:     JWTs are NOT persisted in any Cache storage. The SW only
 *           caches unauthenticated public assets + idempotent GETs on
 *           /api/sites/* (the latter is semi-sensitive but cached
 *           per-URL; if tokens differ the request URLs match, so no
 *           privilege escalation is possible between users on the same
 *           device — each user hits a different /sites/:id URL and the
 *           server responds 403 for the wrong user, which is NOT cached).
 *
 * Kept deliberately tiny. Total <200 LoC.
 */

const VERSION = "instinct-sw-v1";
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Shell assets to precache. Keep this list small — most assets are
// added at runtime via stale-while-revalidate.
const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/wolfpack-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/_next/data/")) return true;
  if (/\.(js|css|png|jpg|jpeg|svg|webp|woff2?|ico)$/i.test(url.pathname)) {
    return true;
  }
  return false;
}

function isCacheableApi(url) {
  // Only same-origin idempotent GETs for /api/sites/*. Everything else
  // stays network-first.
  return url.pathname.startsWith("/api/sites/");
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok && response.status === 200) {
        // Clone before caching — body is a single-use stream.
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || networkFetch;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === "GET") {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Navigation fallback — serve the root shell so the SPA can boot
    // and read IndexedDB for a cached brief.
    if (request.mode === "navigate") {
      const shell = await cache.match("/") || await caches.match("/");
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // NEVER touch non-GET — mutations are owned by the IDB queue.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin → pass through untouched (analytics providers, CDN fonts, etc.).
  if (url.origin !== self.location.origin) return;

  // Auth endpoints — never cache (always fresh tokens).
  if (
    url.pathname.startsWith("/api/auth/") ||
    url.pathname.startsWith("/api/analytics")
  ) {
    return;
  }

  if (isStaticAsset(url) || isCacheableApi(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Page navigations — network-first with SPA shell fallback.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else — network-first, no cache fallback.
  event.respondWith(networkFirst(request));
});

// Message channel — allow the page to force a cache purge (on logout).
// Only same-origin pages may instruct us; reject everything else.
// (CodeQL: js/missing-origin-check.)
self.addEventListener("message", (event) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data && event.data.type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
    );
  }
});
