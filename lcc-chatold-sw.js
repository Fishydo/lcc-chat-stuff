self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || 'lcc-chat', {
    body: data.body || 'New activity', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.type === 'call' ? 'lcc-chat-call' : 'lcc-chat-message', renotify: true,
    data: { url: data.url || '/', type: data.type }, actions: data.type === 'call' ? [{ action: 'open', title: 'Open' }, { action: 'close', title: 'Dismiss' }] : [{ action: 'open', title: 'Open' }]
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list[0] ? list[0].focus() : clients.openWindow(event.notification.data.url || '/')));
});
