/* Geofence Platform — offline service worker (network-first)
   Online: always fetch fresh (so deploys show immediately).
   Offline: fall back to the cached copy.
   Audio is cache-first (large, stable). Bump CACHE to wipe old caches. */
const CACHE = 'gp-offline-v6';

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

  // audio clips — network-first so edits/re-uploads are always reflected;
  // fall back to SW cache when offline
  if (url.pathname.startsWith('/api/audio/')) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        // <audio> elements issue Range requests (esp. iOS Safari) — the
        // Cache API rejects storing 206 Partial Content, and that rejection
        // surfaces to the page as an uncaught "FetchEvent.respondWith
        // received an error" instead of just a failed cache write. Only the
        // full 200 response is cacheable.
        if (res.ok && res.status !== 206) c.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        const hit = await c.match(req);
        return hit || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // everything else (pages, JS, bundle, fonts) — network-first, cache as offline fallback
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.status !== 206) c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await c.match(req);
      return hit || new Response('offline and not cached', { status: 504 });
    }
  })());
});
