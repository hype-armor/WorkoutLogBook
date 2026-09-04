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
const VERSION = '1.14.0'; // x-release-please-version
const CACHE = `logbook-${VERSION}`;

// The exercise photos are 44 files and ~830KB, and they do not change when the
// app does. Keeping them in the app cache would re-download all of it on every
// release, because activate purges the previous version's cache. They live in
// their own cache instead, versioned by hand, and survive app updates.
const MEDIA_VERSION = 1;
const MEDIA_CACHE = `logbook-media-v${MEDIA_VERSION}`;
// Mirrors EXERCISE_INFO in index.html: <img>-0 is the start, <img>-1 the finish.
const MEDIA = [
  './img/barbell-curl-0.webp',
  './img/barbell-curl-1.webp',
  './img/barbell-deadlift-0.webp',
  './img/barbell-deadlift-1.webp',
  './img/dead-bug-0.webp',
  './img/dead-bug-1.webp',
  './img/dumbbell-incline-row-0.webp',
  './img/dumbbell-incline-row-1.webp',
  './img/face-pull-0.webp',
  './img/face-pull-1.webp',
  './img/farmers-walk-0.webp',
  './img/farmers-walk-1.webp',
  './img/front-squat-clean-grip-0.webp',
  './img/front-squat-clean-grip-1.webp',
  './img/incline-dumbbell-press-0.webp',
  './img/incline-dumbbell-press-1.webp',
  './img/leg-press-0.webp',
  './img/leg-press-1.webp',
  './img/lying-leg-curls-0.webp',
  './img/lying-leg-curls-1.webp',
  './img/parallel-bar-dip-0.webp',
  './img/parallel-bar-dip-1.webp',
  './img/pullups-0.webp',
  './img/pullups-1.webp',
  './img/romanian-deadlift-0.webp',
  './img/romanian-deadlift-1.webp',
  './img/seated-cable-rows-0.webp',
  './img/seated-cable-rows-1.webp',
  './img/seated-dumbbell-press-0.webp',
  './img/seated-dumbbell-press-1.webp',
  './img/side-lateral-raise-0.webp',
  './img/side-lateral-raise-1.webp',
  './img/split-squat-with-dumbbells-0.webp',
  './img/split-squat-with-dumbbells-1.webp',
  './img/standing-calf-raises-0.webp',
  './img/standing-calf-raises-1.webp',
  './img/standing-military-press-0.webp',
  './img/standing-military-press-1.webp',
  './img/trap-bar-deadlift-0.webp',
  './img/trap-bar-deadlift-1.webp',
  './img/triceps-pushdown-0.webp',
  './img/triceps-pushdown-1.webp',
  './img/wide-grip-lat-pulldown-0.webp',
  './img/wide-grip-lat-pulldown-1.webp'
];

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
    // Photos only if this media version is not already on disk: a plain
    // cache.add here would refetch 830KB on every app update.
    const media = await caches.open(MEDIA_CACHE);
    await Promise.all(MEDIA.map(async url => {
      if(await media.match(url)) return;
      await media.add(url).catch(() => {});
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('logbook-') && k !== CACHE && k !== MEDIA_CACHE)
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
    // Across every cache, so a photo in the media cache is found too.
    const cached = await caches.match(req, {ignoreSearch: true});

    const fromNetwork = fetch(req).then(async res => {
      if(res && res.ok && res.type === 'basic'){
        const dest = url.pathname.endsWith('.webp') ? await caches.open(MEDIA_CACHE) : cache;
        dest.put(req, res.clone());
      }
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
