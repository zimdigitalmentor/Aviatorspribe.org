// ===== Service worker: offline support + updates =====
// Bump VERSION whenever you change any file so installed apps pick up the update.
const VERSION = 'v2.0.3';
const CACHE = `aviator-tracker-${VERSION}`;
const FONT_CACHE = 'aviator-tracker-fonts';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/math.js',
  './js/store.js',
  './js/format.js',
  './js/trackers.js',
  './js/render.js',
  './js/install.js',
  './js/api.js',
  './js/device.js',
  './js/session.js',
  './js/subscribe.js',
  './js/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon.ico',
  './img/logo.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => { cache.put(req, res.clone()); return res; }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Google sign-in (accounts.google.com) and every other origin: straight to the network
  if (url.origin !== location.origin) return;

  // API calls and the Paynow return page are never cached
  if (url.pathname.startsWith('/api/')) return;

  // Page navigations: network first, fall back to cached app shell (works offline)
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // Static files: cache first
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
