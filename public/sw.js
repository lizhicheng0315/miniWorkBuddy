/* WorkBuddy Service Worker - 静态资源离线缓存 */
const CACHE = 'workbuddy-v4';
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 只处理同源 GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 跳过 /api/*：始终走网络
  if (url.pathname.startsWith('/api/')) return;

  // 关键：app.js / styles.css / index.html 永远走网络（cache-busting 友好）
  const noCachePaths = ['/app.js', '/styles.css', '/index.html', '/'];
  if (noCachePaths.some(p => url.pathname === p || url.pathname === p + '.html')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => caches.match(req))
    );
    return;
  }

  // 其它资源：network-first，离线时回退缓存
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
