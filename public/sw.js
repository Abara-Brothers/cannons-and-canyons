// Cannons & Canyons service worker: exists for TURN NUDGES (Web Push) and to
// make the app installable. Deliberately no asset caching — the game is a
// live-updated single page and a stale cache is worse than a cold load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
