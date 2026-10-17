/* Grupo-E: recebe os avisos push do navegador (service worker). Fica na raiz do site para valer em /cs e no sistema principal. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (ev) { ev.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (ev) {
  var d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { titulo: 'Aviso do Grupo-E', texto: ev.data ? ev.data.text() : '' }; }
  ev.waitUntil((async function () {
    var janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    var visiveis = janelas.filter(function (c) { return c.visibilityState === 'visible'; });
    // Página aberta e à vista: ela mesma mostra o balão e toca o som (sem duplicar com a notificação do sistema).
    if (visiveis.length) { visiveis.forEach(function (c) { c.postMessage({ tipo: 'push', aviso: d }); }); return; }
    await self.registration.showNotification(d.titulo || 'Aviso do Grupo-E', {
      body: d.texto || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/img/logo-grupo-e.png', data: { url: d.url || '/cs' },
    });
  })());
});

self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  var url = (ev.notification.data && ev.notification.data.url) || '/cs';
  ev.waitUntil((async function () {
    var janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < janelas.length; i++) {
      var c = janelas[i];
      if (c.url && c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
        try { await c.focus(); if ('navigate' in c) await c.navigate(url); return; } catch (e) { /* tenta abrir outra */ }
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
