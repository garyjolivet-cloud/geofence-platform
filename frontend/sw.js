/* Geofence Platform — offline service worker (network-first)
   Online: always fetch fresh (so deploys show immediately).
   Offline: fall back to the cached copy.

   Two caches, on purpose:
   - PAGE_CACHE  — pages / JS / bundle / fonts. Small. Wiped on every deploy
     (bump PAGE_CACHE) so stale code can't linger offline.
   - AUDIO_CACHE — audio clips only. Can grow to tens/hundreds of MB. NEVER
     wiped on a code deploy: deleting a cache that large inside activate's
     waitUntil used to stall every fetch (blank screen for 20-30s) on the
     first navigation after a deploy. Its name has no version — audio is
     addressed by immutable per-clip URLs, so there's nothing to invalidate.
   activate cleanup also runs OUTSIDE waitUntil so claim()/control is never
   held up by cache deletion. */
const PAGE_CACHE = 'gp-offline-v17';
const AUDIO_CACHE = 'gp-audio';
const KEEP = new Set([PAGE_CACHE, AUDIO_CACHE]);

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  // Take control right away; don't make it wait on cache deletion.
  e.waitUntil(self.clients.claim());
  // Best-effort, non-blocking: drop any cache that isn't one we keep
  // (old gp-offline-vN from previous deploys).
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))))
    .catch(() => {});
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // audio clips — network-first so edits/re-uploads are always reflected;
  // fall back to the (unversioned, persistent) audio cache when offline
  if (url.pathname.startsWith('/api/audio/')) {
    e.respondWith((async () => {
      const c = await caches.open(AUDIO_CACHE);
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
    const c = await caches.open(PAGE_CACHE);
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
