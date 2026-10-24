// CloudLift service worker: makes the app installable and shows a friendly page when the server can't be reached.
// It never caches the app's data: transfers, accounts and sign-ins always go to the server.
const CACHE = 'cloudlift-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE, '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const { pathname } = new URL(req.url);
  // The offline page's icon is also served from the cache when the network fails.
  if (pathname === '/icons/icon-192.png') {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  // Only page loads get the offline fallback; sign-in redirects and API calls are left alone.
  if (req.mode !== 'navigate' || pathname.startsWith('/auth/')) return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});
