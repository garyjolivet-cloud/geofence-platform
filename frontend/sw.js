/* Geofence Platform — offline service worker (network-first)
   Online: always fetch fresh (so deploys show immediately).
   Offline: fall back to the cached copy.
   Audio is cache-first (large, stable). Bump CACHE to wipe old caches. */
const CACHE = 'gp-offline-v2';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // audio clips — cache-first (large, rarely change)
  if (url.pathname.startsWith('/api/audio/')) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch (err) { return hit || new Response('', { status: 504 }); }
    }));
    return;
  }

  // everything else (pages, JS, bundle, fonts) — network-first, cache as offline fallback
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(req);
      return hit || new Response('offline and not cached', { status: 504 });
    }
  })());
});
