const { test, expect } = require('@playwright/test');
const { SYNC_URL, phone } = require('./helpers');

// A push event cannot be delivered to a service worker from a test, and a real
// PushSubscription needs a real push service. What can be checked — and is the
// part that would silently break — is that what the page seals is what the
// worker opens. The worker's key derivation is written out a second time in
// sw.js because a worker cannot borrow a function from the page, and two copies
// of a derivation are two chances to get it wrong.
//
// So this runs the actual bytes of sw.js, with `self` stubbed, against a
// payload sealed by the actual vault in the page.
test.describe('what the worker can open', () => {
  let ctx, page;

  test.beforeAll(async ({ browser }) => {
    ctx = await phone(browser);
    page = await ctx.newPage();
    await page.goto(SYNC_URL);
    await page.waitForSelector('.ex');
  });
  test.afterAll(async () => { await ctx.close(); });

  /**
   * Seal a payload the way alertSchedule does, then hand it to the push
   * listener that sw.js actually registers.
   */
  const deliver = ({ title, body, at, storeKey = true, visible = false, payload = null }) =>
    page.evaluate(async (opts) => {
      const mk = vault.newKey();
      const keys = await vault.subkeys(mk);
      const sealed = opts.payload ?? await vault.seal(keys.alert, 'alert', 'v1',
        { t: opts.title, b: opts.body, at: opts.at });

      // What pushEnable() leaves for the worker.
      const put = (k, v) => new Promise((res, rej) => {
        const req = indexedDB.open('logbook-keys', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          const d = req.result;
          const t = d.transaction('kv', 'readwrite');
          if (v === null) t.objectStore('kv').delete(k); else t.objectStore('kv').put(v, k);
          t.oncomplete = () => { d.close(); res(); };
          t.onerror = () => { d.close(); rej(t.error); };
        };
        req.onerror = () => rej(req.error);
      });
      await put('mk', opts.storeKey ? b64u(mk) : null);

      const src = await (await fetch('./sw.js')).text();
      const listeners = {};
      const shown = [];
      const stub = {
        addEventListener: (k, fn) => { listeners[k] = fn; },
        registration: { showNotification: (t, o) => { shown.push({ title: t, ...o }); return Promise.resolve(); } },
        clients: {
          matchAll: async () => (opts.visible ? [{ visibilityState: 'visible' }] : []),
          claim: async () => {}, openWindow: async () => {}
        },
        location: { origin: location.origin },
        skipWaiting: () => {}
      };
      // The real file, in its own scope so its consts do not meet the page's.
      new Function('self', 'caches', src)(stub, caches);

      await new Promise(done => listeners.push({
        waitUntil: p => Promise.resolve(p).then(done, done),
        data: { text: () => sealed }
      }));
      return { shown, sealed };
    }, { title, body, at, storeKey, visible, payload });

  test('a sealed alert arrives as the words that were sealed', async () => {
    const { shown, sealed } = await deliver({
      title: 'Rest complete', body: 'Romanian deadlift', at: Date.now()
    });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Rest complete');
    expect(shown[0].body).toBe('Romanian deadlift');
    // Replaces rather than stacks, the same tag the page has always used.
    expect(shown[0].tag).toBe('logbook-rest');
    // And the thing the server held says none of it.
    expect(sealed).not.toContain('deadlift');
    expect(sealed).not.toContain('Rest');
  });

  test('an alert that arrives late says how late', async () => {
    const { shown } = await deliver({
      title: 'Rest complete', body: 'Deadlift', at: Date.now() - 11 * 60 * 1000
    });
    // A push relayed through a push service is exactly the thing that can turn
    // up long after the moment it describes. Saying "rest complete" then is the
    // one statement that is not true.
    expect(shown[0].body).toMatch(/Deadlift — ended 11 min ago/);
  });

  test('an alert inside the grace window is not dressed up as late', async () => {
    const { shown } = await deliver({
      title: 'Rest complete', body: 'Deadlift', at: Date.now() - 3000
    });
    expect(shown[0].body).toBe('Deadlift');
  });

  test('nothing is raised over an app that is already on screen', async () => {
    const { shown } = await deliver({
      title: 'Rest complete', body: 'Deadlift', at: Date.now(), visible: true
    });
    // The timer on screen already went green.
    expect(shown).toEqual([]);
  });

  test('a payload it cannot open still raises the alert it promised', async () => {
    // Notifications on, key gone: turned off on this device, or a vault whose
    // key was rotated. The timer did end, and that is what was promised.
    const { shown } = await deliver({
      title: 'Rest complete', body: 'Deadlift', at: Date.now(), storeKey: false
    });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Rest complete');
    expect(shown[0].body).toBe('Next set');
  });

  test('a payload sealed under another key is not shown as though it were ours', async () => {
    const other = await page.evaluate(async () => {
      const keys = await vault.subkeys(vault.newKey());
      return vault.seal(keys.alert, 'alert', 'v1', { t: 'Not yours', b: 'Squat', at: Date.now() });
    });
    const { shown } = await deliver({ title: 'x', body: 'y', at: Date.now(), payload: other });
    expect(shown).toHaveLength(1);
    expect(shown[0].body).not.toBe('Squat');
    expect(shown[0].title).toBe('Rest complete');
  });
});
