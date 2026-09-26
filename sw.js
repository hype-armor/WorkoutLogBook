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
const VERSION = '1.22.1'; // x-release-please-version
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

  // The API is not the app, and must never be answered from cache. Every one of
  // these is specific to the moment it was asked — and the lookup below ignores
  // the query string, so a cached `/v1/sync?since=0` from an empty vault was
  // being handed back for a pull at every later cursor. Sync stopped dead after
  // the first request and said nothing, because an empty answer is a valid one.
  if(url.pathname.startsWith('/v1/') || url.pathname === '/healthz'
     || url.pathname === '/readyz') return;

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

/* ---------- push ---------- */
// What arrives here is a sealed envelope. The server scheduled it and relayed
// it and could not read a word of it; this is the only place with the key.
//
// The key derivation is repeated here rather than shared with the page: a
// service worker has its own global scope and cannot borrow one function out of
// index.html. Twenty lines, and the alternative is a payload the server has to
// compose — which would mean telling it which lift you are resting from.
const utf8 = new TextEncoder(), utf8d = new TextDecoder();
const unb64u = str => {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for(let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

// The page writes the master key here when notifications are turned on, because
// localStorage is synchronous and a worker is never given it.
function masterKey(){
  return new Promise(resolve => {
    let req;
    try{ req = indexedDB.open('logbook-keys', 1); }catch(e){ return resolve(null); }
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const d = req.result;
      try{
        const get = d.transaction('kv', 'readonly').objectStore('kv').get('mk');
        get.onsuccess = () => { resolve(get.result || null); d.close(); };
        get.onerror = () => { resolve(null); d.close(); };
      }catch(e){ resolve(null); d.close(); }
    };
  });
}

async function openAlert(data){
  const mk = await masterKey();
  if(!mk || !data) return null;
  const base = await crypto.subtle.importKey('raw', unb64u(mk), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode('logbook/alert/1')},
    base, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
  const raw = unb64u(data);
  const plain = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: utf8.encode('alert|v1')},
    key, raw.slice(12));
  return JSON.parse(utf8d.decode(plain));
}

// Ten seconds, the same window the page uses. A notification that arrives long
// after the timer ended says the timer just ended, which is the one thing that
// is not true — and an alert relayed through a push service is exactly the
// thing that can arrive late.
const LATE_GRACE = 10;
function lateLabel(secs){
  if(secs < LATE_GRACE) return '';
  if(secs < 90) return `${Math.round(secs)} sec ago`;
  if(secs < 5400) return `${Math.round(secs / 60)} min ago`;
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return `${h} h${m ? ' ' + m : ''} ago`;
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let title = 'Rest complete', body = 'Next set';
    try{
      const alert = await openAlert(event.data && event.data.text());
      if(alert){
        title = alert.t || title;
        const late = lateLabel((Date.now() - (alert.at || Date.now())) / 1000);
        body = late ? `${alert.b || 'Next set'} — ended ${late}` : (alert.b || body);
      }
    }catch(e){
      // Locked, rotated, or not ours to read. A generic alert is still the
      // right thing to raise: the timer did end, and that is what was promised.
    }
    // On screen already: the timer went green, and a banner over it is noise.
    const open = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    if(open.some(c => c.visibilityState === 'visible')) return;
    await self.registration.showNotification(title, {
      body,
      tag: 'logbook-rest',        // replaces rather than stacks
      icon: './icon-192.png',
      badge: './icon-192.png'
    });
  })());
});

// A notification raised through the registration — which on iOS is the only
// kind there is — has no onclick of its own: the worker handles the tap. Focus
// a window that is already open rather than adding a second copy of an app
// whose whole state is in one tab.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for(const c of open){
      if('focus' in c) return c.focus();
    }
    if(self.clients.openWindow) return self.clients.openWindow('./');
  })());
});

// The page asks for the update rather than being reloaded out from under a
// set being logged.
self.addEventListener('message', event => {
  const data = event.data;
  if(data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});
