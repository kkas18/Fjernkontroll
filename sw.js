const CACHE='fjern-pwa-v1';
const ASSETS=['/','/index.html','/style.css','/app.js','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-192.png','/icons/icon-maskable-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
    return response;
  }).catch(()=>caches.match(e.request)));
});
