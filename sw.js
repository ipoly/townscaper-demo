// Offline support: app files are fetched network-first so deploys show up right away, while the
// pinned Three.js build from the CDN never changes and is served cache-first.

const CACHE = 'townscaper-v1';
const THREE_BASE = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
const CORE = [
  './',
  './main.js',
  './town.js',
  './grid.js',
  './audio.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/icon-192.png',
  THREE_BASE + 'build/three.module.js',
  THREE_BASE + 'examples/jsm/controls/OrbitControls.js',
];

self.addEventListener('install', (e) => {
  // Precache what is available; a missing optional file must not block installation
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.href.startsWith(THREE_BASE)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => put(req, res))));
  } else if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => put(req, res))
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))),
    );
  }
});

function put(req, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
