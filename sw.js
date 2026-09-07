// Offline support without stale-app syndrome.
//
// App files change every deploy, so they are network-first: fetch fresh, fall back to
// cache when offline. The MediaPipe wasm and the .task model are large, immutable and
// live at versioned URLs, so those are cache-first — the expensive part downloads once.
const APP = 'form-app-v3';
const VENDOR = 'form-vendor-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './poses.js', './glyph.js', './store.js', './demo.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const VENDOR_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== APP && k !== VENDOR).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (VENDOR_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(VENDOR).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res.ok) (await caches.open(APP)).put(request, res.clone());
      return res;
    } catch {
      const hit = await caches.match(request);
      if (hit) return hit;
      // Only a navigation may fall back to the shell. Handing index.html to a failed
      // module request serves HTML as a script, and the app boots to a blank page.
      if (request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
