// Blaksyd web-push service worker (Phase 5). Shows incoming pushes and focuses
// the app on click. Scope: site root (registered from /beta/).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  event.waitUntil(self.registration.showNotification(d.title || 'Blaksyd', {
    body: d.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/beta/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/beta/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if ('focus' in w && w.url.includes('/beta')) { try { w.navigate && w.navigate(url); } catch (e) {} return w.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
