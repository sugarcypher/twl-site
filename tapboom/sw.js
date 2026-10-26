// TapBoom offline worker. Bump VERSION on every release so phones pick it up.
const VERSION = 'tapboom-1.4.0-1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The page: try the network first (so updates arrive), but never wait more than
// three seconds for it; with no signal, play the cached copy.
function pageFirstNetwork(req) {
  const fromCache = () => caches.match('./index.html');
  const fromNet = fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000)).then(fromCache);
  return Promise.race([fromNet.catch(fromCache), timeout]).then((r) => r || fromNet.catch(fromCache));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') { e.respondWith(pageFirstNetwork(req)); return; }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
