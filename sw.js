/* Logbook service worker.
 *
 * The point of this file is that the app opens in a gym with no signal. The
 * shell is precached on install and served from cache first, so a launch never
 * waits on the network; a fresh copy is fetched in the background and used on
 * the next launch.
 *
 * Releasing: VERSION is maintained by Release Please — the annotation below is
 * what it rewrites, so merging a release PR is what ships an update. A browser
 * only looks for a new worker when this file's bytes change, so editing
 * index.html alone would reach installed users one launch later (via the
 * background refresh) without ever offering them the prompt. The version bump
 * does both, and purges the previous cache on activate.
 */
const VERSION = '1.5.1'; // x-release-please-version
const CACHE = `logbook-${VERSION}`;

// Relative so the app works from a subdirectory (e.g. GitHub Pages projects).
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not fail the whole install, which would leave the
    // app with no offline copy at all.
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, {cache: 'reload'})).catch(() => {})));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('logbook-') && k !== CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return; // nothing external to cache

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, {ignoreSearch: true});

    const fromNetwork = fetch(req).then(res => {
      if(res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    // Cache first, refresh behind it.
    if(cached){
      event.waitUntil(fromNetwork);
      return cached;
    }

    const res = await fromNetwork;
    if(res) return res;

    // Offline with nothing cached for this exact URL: a navigation should
    // still land on the app rather than the browser's error page.
    if(req.mode === 'navigate'){
      const shell = await cache.match('./index.html') || await cache.match('./');
      if(shell) return shell;
    }
    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: {'Content-Type': 'text/plain'}
    });
  })());
});

// The page asks for the update rather than being reloaded out from under a
// set being logged.
self.addEventListener('message', event => {
  const data = event.data;
  if(data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});
