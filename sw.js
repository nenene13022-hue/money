/* Service worker for כספית — only used when the app is hosted online (e.g. GitHub Pages).
   It is never registered when the file is opened directly via file:// (see app.js), so it
   has zero effect on the standalone double-click version of the app.
   Chart.js, SheetJS and Heebo are vendored under ./vendor and precached here so the app
   shell, charts, Excel export and Hebrew font work offline after the first successful load. */

const CACHE_NAME = 'kaspit-cache-v4';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.png',
  './apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './vendor/chart.umd.min.js',
  './vendor/xlsx.full.min.js',
  './firebase-config.js',
  './cloud-merge.js',
  './firebase-sync.js',
  './vendor/fonts/heebo.css',
  './vendor/fonts/heebo-hebrew.woff2',
  './vendor/fonts/heebo-latin.woff2',
  './vendor/fonts/heebo-latin-ext.woff2',
  './vendor/fonts/heebo-math.woff2',
  './vendor/fonts/heebo-symbols.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function cacheFirstWithRefresh(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // Always prefer a fresh Firebase config so a pasted key is picked up on refresh.
  if (url.pathname.endsWith('/firebase-config.js')) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', response.clone());
        return response;
      } catch (e) {
        return (await caches.match('./index.html'))
          || (await caches.match('./'))
          || Response.error();
      }
    })());
    return;
  }

  event.respondWith(cacheFirstWithRefresh(request));
});
