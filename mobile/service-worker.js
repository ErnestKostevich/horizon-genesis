// Minimal service worker — caches the app shell so the PWA opens
// offline. We never cache /api/* responses (those are dynamic +
// auth-bound).

// Bumped to v2 when the pair-view UX was redesigned (QR scan primary,
// manual fields collapsed). Old clients pick up the new shell on next
// load instead of being stuck on the cached v1 form.
const CACHE_NAME = 'horizon-pwa-v2';
const APP_SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls — they need fresh auth + token routing.
  if (url.pathname.startsWith('/api/')) return;
  // Network-first for HTML so updates land immediately, cache fallback for offline.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('index.html'))
    );
    return;
  }
  // Cache-first for the static shell.
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached || fetch(event.request).then((res) => {
        // Stash the response if it's same-origin
        if (res.ok && url.origin === self.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
