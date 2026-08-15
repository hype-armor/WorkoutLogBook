const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { APP_PATH, SW_PATH, FILE_URL, phone, watchErrors } = require('./helpers');

// These run over http because a service worker needs a secure context.
test.describe('installable and offline', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx, page, errs, base;

  test.beforeAll(async ({ browser, baseURL }) => {
    base = baseURL;
    ctx = await phone(browser);
    page = await ctx.newPage();
    // Navigating straight to a .png or .webmanifest makes Chrome ask for
    // /favicon.ico for the tab; that is the harness, not the app.
    errs = watchErrors(page, { ignore: ['/favicon.ico'] });
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('the manifest is served correctly and describes an installable app', async () => {
    const res = await page.goto(base + 'manifest.webmanifest');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('manifest+json');

    const man = JSON.parse(await res.text());
    expect(man.name).toBeTruthy();
    expect(man.display).toBe('standalone');
    // relative, so a project page at /WorkoutLogBook/ works unchanged
    expect(man.start_url).toBe('./');
    expect(man.scope).toBe('./');
    expect(man.icons.some(i => i.sizes === '192x192')).toBe(true);
    expect(man.icons.some(i => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(man.icons.some(i => i.purpose === 'maskable')).toBe(true);

    for (const icon of man.icons) {
      const r = await page.goto(base + icon.src.replace('./', ''));
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()['content-type'], icon.src).toContain('image/png');
    }
  });

  test('the service worker activates and precaches the shell', async () => {
    await page.goto(base);
    // `ready` resolves as soon as there is an active worker, which can still
    // be "activating" while the activate handler purges old caches.
    await expect.poll(async () => page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return r.active && r.active.state;
    }), { timeout: 10000 }).toBe('activated');
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(base);

    await page.reload();
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const c = await caches.open(keys[0]);
      return { keys, urls: (await c.keys()).map(r => new URL(r.url).pathname) };
    });
    expect(cached.keys).toHaveLength(1);
    expect(cached.keys[0]).toMatch(/^logbook-/);
    expect(cached.urls).toEqual(expect.arrayContaining(
      ['/index.html', '/manifest.webmanifest', '/icon-512.png']));
  });

  test('the app and its data survive with the network off', async () => {
    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '245');
    await page.fill('#reps', '5');
    await page.click('#logset');
    await page.click('#close');

    await ctx.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle('Logbook');
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('1/4');

    // a URL that was never visited should still land on the app, not an error page
    const deep = await page.goto(base + 'index.html');
    expect(deep.status()).toBe(200);
    await ctx.setOffline(false);
  });

  test('an edit is served stale once, then fresh', async () => {
    const original = fs.readFileSync(APP_PATH, 'utf8');
    try {
      fs.writeFileSync(APP_PATH, original.replace('<title>Logbook</title>',
        '<title>Logbook</title><!-- edit-probe -->'));
      await page.goto(base);
      expect(await page.content()).not.toContain('edit-probe');
      await page.goto(base);
      expect(await page.content()).toContain('edit-probe');
    } finally {
      fs.writeFileSync(APP_PATH, original);
    }
  });

  test('a new version is offered rather than forced', async () => {
    const original = fs.readFileSync(SW_PATH, 'utf8');
    const bumped = original.replace(/const VERSION = '[^']+'/, "const VERSION = '99.0.0'");
    expect(bumped).not.toBe(original);

    try {
      // An update only makes sense against a page a worker already controls;
      // a first install must stay silent.
      await page.goto(base);
      await expect.poll(async () =>
        page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

      fs.writeFileSync(SW_PATH, bumped);
      // Publish first, then load: update() against an unchanged sw.js is a
      // no-op, and a navigation makes the browser re-fetch the worker script
      // anyway, so there is no window where the two can race.
      await expect.poll(async () =>
        (await (await fetch(base + 'sw.js', { cache: 'no-store' })).text()).includes("'99.0.0'")
      ).toBe(true);

      await page.goto(base);
      await expect(page.locator('#banners')).toContainText(/new version/i, { timeout: 20000 });
      // it must not reload on its own: that would discard a half-entered set
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

      // Applying it reloads the page on purpose, so the evaluate below races
      // with a navigation until the new worker has taken over.
      await page.click('#banners [data-act="update"]');
      await expect.poll(async () => {
        try { return await page.evaluate(() => caches.keys()); }
        catch { return []; } // mid-navigation
      }, { timeout: 20000 }).toContain('logbook-99.0.0');

      const keys = await page.evaluate(() => caches.keys());
      expect(keys).toHaveLength(1); // the previous cache is purged
    } finally {
      fs.writeFileSync(SW_PATH, original);
    }
  });

  test('no page errors', () => {
    expect(errs).toEqual([]);
  });
});

test('the app still works opened straight from disk', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');

  await page.click('.ex[data-ex="Deadlift"]');
  await page.fill('#wt', '135');
  await page.fill('#reps', '5');
  await page.click('#logset');
  // saving is debounced, so poll rather than reading straight after the tap
  await expect.poll(async () =>
    page.evaluate(() => !!localStorage.getItem('logbook-v1'))).toBe(true);
  // registration is skipped on file:// rather than throwing
  expect(errs).toEqual([]);
  await ctx.close();
});

test('the version is shown in settings and matches sw.js', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.goto(FILE_URL);
  await page.click('#gear');

  const shown = await page.textContent('#appversion');
  const swVersion = /const VERSION = '([^']+)'/.exec(fs.readFileSync(SW_PATH, 'utf8'))[1];
  // release-please bumps both; drift means one annotation was lost
  expect(shown).toBe(`Logbook ${swVersion}`);
  await ctx.close();
});
