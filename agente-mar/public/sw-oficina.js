// sw-oficina.js — permite instalar la Oficina como app y abrirla aunque falle la conexión.
// Siempre intenta traer lo último de la red; si no hay red, muestra la última copia guardada.
// Los datos (/api/...) nunca se guardan: siempre vienen en vivo del servidor.
const CACHE = 'oficina-v1';
const BASE = ['/oficina', '/oficina.js', '/styles.css', '/manifest-oficina.webmanifest', '/icons/oficina-192.png', '/icons/oficina-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhook/')) return;
  if (!BASE.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request))
  );
});
