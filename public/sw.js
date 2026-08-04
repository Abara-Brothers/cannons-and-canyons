// Cannons & Canyons service worker: turn nudges (Web Push), installability,
// and the offline app shell.
//
// This USED to cache nothing, on the reasoning that "a stale cache is worse
// than a cold load". That reasoning was right for a purely online game and is
// wrong now: ADR-001/BQ-007 require vs-CPU duel and solo golf to work with no
// network, and a page that cannot even load obviously cannot play.
//
// The staleness concern is answered by strategy rather than by refusing to
// cache. Navigations are NETWORK-FIRST, so an online player always gets the
// current build and can never be pinned to an old one; the cache is only
// consulted when the network genuinely fails. Static assets are
// stale-while-revalidate: instant from cache, refreshed in the background for
// next time.
//
// NOTE for the native app: this file is irrelevant there. A Capacitor build
// loads its assets from the bundle, so offline loading is already free. This
// exists for the web/PWA path only.
const VERSION = 'cc-v1';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'config.js',
  'game-core.js',        // the authoritative simulation — offline play needs it
  'styles.css',
  'manifest.webmanifest',
  'privacy.html',        // reachable offline: it is a store requirement (ISSUE-013)
  'icons/icon.svg',
  'icons/icon-32.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/favicon-16.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll() is all-or-nothing: one 404 and the whole worker fails to
    // install, silently leaving the app with no offline support at all.
    // Cache individually so a single missing icon cannot cost us the shell.
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] could not precache', url, err); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // never touch other origins
  // /push/* is state, not an asset, and /ws never reaches fetch anyway.
  if (url.pathname.startsWith('/push/')) return;

  // Navigations: network-first so an online player is never stuck on an old
  // build; cached shell only when the network actually fails.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(data.title || 'Cannons & Canyons', {
    body: data.body || 'Your turn is up.',
    icon: '/icons/icon-180.png',
    badge: '/icons/icon-180.png',
    tag: 'cc-turn',                       // a newer nudge replaces the old one
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { c.navigate(url); return c.focus(); }
    }
    return clients.openWindow(url);
  }));
});
