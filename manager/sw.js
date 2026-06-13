const CACHE_NAME = 'gestor-wa-v1';
const ASSETS = ['/', '/manager.css', '/manager.js'];

// Instalación: guarda los ficheros en caché para uso sin conexión
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activación: elimina cachés antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: sirve desde caché si está disponible (network-first para la API)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Notificación push recibida
self.addEventListener('push', event => {
  let data = { title: 'Nuevo mensaje', body: 'Tienes un mensaje nuevo de un huésped', phone: '' };
  try { data = event.data.json(); } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'msg-' + (data.phone || Date.now()),
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: '/' },
    })
  );
});

// Clic en la notificación: abre o enfoca el panel
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const panel = list.find(c => c.url.includes(self.location.origin));
      if (panel) return panel.focus();
      return clients.openWindow('/');
    })
  );
});
