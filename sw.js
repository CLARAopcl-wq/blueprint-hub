// Blueprint Hub Service Worker — Push Notifications
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Blueprint Hub';
  const options = {
    body: data.body || 'You have a new notification.',
    icon: '/images/bh-icon.png',
    badge: '/images/bh-badge.png',
    tag: data.tag || 'bh-notification',
    data: { url: data.url || '/app.html' },
    vibrate: [200, 100, 200],
    requireInteraction: data.requireInteraction || false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/app.html';
  event.waitUntil(clients.openWindow(url));
});

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});
