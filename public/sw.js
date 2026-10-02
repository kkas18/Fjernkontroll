// Nettverk først, med hurtigbuffer som reserve når broen ikke svarer.
// Versjonen må være lik "version" i package.json (sjekkes av testene).
const CACHE = 'fjern-2.10.1';
const ASSETS = [
  '/',
  '/style.css',
  '/app.js',
  '/logic.js',
  '/fonts/manrope-latin-wght.woff2',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match('/') : Response.error())),
  );
});
