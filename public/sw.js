/* sw.js — minimal service worker for the PWA shell.
 *
 * Strategy:
 *   - Static assets (HTML, CSS, JS, icons) are served cache-first so
 *     the /quick screen opens instantly when the phone is offline or
 *     on a flaky network.
 *   - API requests are always network-only. We never cache /api/*.
 *   - A new SW version bumps CACHE_VERSION, which evicts the old cache
 *     the next time the user opens the app.
 */

const CACHE_VERSION = 'tt-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/calc.js',
  '/js/storage.js',
  '/js/ui.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg'
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);

  // API calls: always go to the network, never cache.
  if (url.pathname.startsWith('/api/')) return;

  // Same-origin GETs for the shell: cache-first, falling back to
  // network, and updating the cache in the background.
  if (ev.request.method !== 'GET' || url.origin !== self.location.origin) return;

  ev.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(ev.request, { ignoreSearch: true });
      const networkPromise = fetch(ev.request).then((res) => {
        if (res && res.ok) cache.put(ev.request, res.clone());
        return res;
      }).catch(() => cached || Response.error());
      return cached || networkPromise;
    })
  );
});
