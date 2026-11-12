// Keeps a copy of the app on the device, so it still opens when the site is unreachable.
// Network first: a fresh copy is used whenever one can be fetched.
const CACHE = 'fkn-app-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add(self.registration.scope)).catch(() => {}));
});

self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match(self.registration.scope) : undefined))
      .then((hit) => hit || new Response('', { status: 504 })))
  );
});
