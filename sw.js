/* Geofence Platform — offline service worker
   - app shell (engine HTML) + fonts: cache-first so it loads with no signal
   - audio clips: cache-first (big, rarely change)
   - project bundle: network-first, fall back to cache
   Bump CACHE to invalidate everything after a deploy. */
const CACHE = 'gp-offline-v1';

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

  // audio assets — cache-first (large, stable)
  if (url.pathname.startsWith('/api/audio/')) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch (err) { return hit || new Response('', { status: 504 }); }
    }));
    return;
  }

  // project bundle — network-first so it's fresh online, cached for offline
  if (url.pathname.includes('/bundle')) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch (err) {
        const hit = await c.match(req);
        return hit || new Response(JSON.stringify({ error: 'offline, not cached' }),
          { status: 504, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }

  // app shell (engine page) + fonts — cache-first, refresh in background
  const sameOrigin = url.origin === location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (req.mode === 'navigate' || sameOrigin || isFont) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
});
