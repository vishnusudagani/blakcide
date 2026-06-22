// Blaksyd web-push service worker (Phase 5). Shows incoming pushes and focuses
// the app on click. Scope: site root (registered from /beta/).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  // Pushes are payloadless by design (no body sent), so these warm defaults are
  // what the user actually sees; tapping opens Blak where the nudge is waiting.
  event.waitUntil(self.registration.showNotification(d.title || 'Blak', {
    body: d.body || 'Blak was thinking of you — tap to see',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: d.tag || 'blak-nudge',
    renotify: true,
    data: { url: d.url || '/beta/blak/' },
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
