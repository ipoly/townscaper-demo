// Offline support: app files are fetched network-first so deploys show up right away, while the
// pinned Three.js build kept in vendor/ never changes and is served cache-first.

const CACHE = 'townscaper-v2';
const VENDOR = new URL('./vendor/', self.location).href;
const CORE = [
  './',
  './main.js',
  './town.js',
  './town/constants.js',
  './town/emitter.js',
  './town/parts/props.js',
  './town/parts/landmarks.js',
  './town/parts/roofs.js',
  './town/parts/carry.js',
  './town/parts/walls.js',
  './grid.js',
  './audio.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './vendor/three/three.module.min.js',
  './vendor/three/addons/controls/OrbitControls.js',
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
  if (url.href.startsWith(VENDOR)) {
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
