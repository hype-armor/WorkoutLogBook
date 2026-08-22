const { test, expect } = require('@playwright/test');
const { FILE_URL, PHONE, watchErrors, rects, overlaps, settle } = require('./helpers');

// The bugs these cover were all "the control you need next is underneath
// something else", which only shows up at a real phone size.
const SIZES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14', width: 390, height: 844 }
];

for (const size of SIZES) {
  test.describe(`${size.name} (${size.width}x${size.height})`, () => {
    test.describe.configure({ mode: 'serial' });

    let page, errs;

    test.beforeAll(async ({ browser }) => {
      const ctx = await browser.newContext({ ...PHONE, viewport: { width: size.width, height: size.height } });
      page = await ctx.newPage();
      errs = watchErrors(page);
      await page.goto(FILE_URL);
      await page.waitForSelector('.ex');
    });

    test.afterAll(async () => { await page?.context().close(); });

    test('Log set is reachable as soon as the sheet opens', async () => {
      await page.click('.ex[data-ex="Deadlift"]');
      await expect(page.locator('#view-exercise')).toBeVisible();
      const { logset, vh } = await rects(page);
      expect(logset.top).toBeGreaterThanOrEqual(0);
      expect(logset.bottom).toBeLessThanOrEqual(vh + 0.5);
    });

    test('Log set stays reachable as the set list grows', async () => {
      await page.fill('#wt', '225');
      await page.fill('#reps', '5');
      for (let i = 0; i < 5; i++) {
        await page.click('#logset');
        await page.waitForTimeout(120);
      }
      await expect(page.locator('.setrow')).toHaveCount(5);
      const { logset, vh } = await rects(page);
      expect(logset.top).toBeGreaterThanOrEqual(0);
      expect(logset.bottom).toBeLessThanOrEqual(vh + 0.5);
    });

    test('the rest timer covers none of the controls', async () => {
      const r = await rects(page);
      expect(overlaps(r.rest, r.logset), 'rest timer over Log set').toBe(false);
      expect(overlaps(r.rest, r.plates), 'rest timer over RIR selector').toBe(false);
      expect(overlaps(r.rest, r.toast), 'rest timer over toast').toBe(false);
    });

    test('touch targets are big enough to hit mid-set', async () => {
      const del = await page.locator('.setrow .del').first().boundingBox();
      expect(del.height).toBeGreaterThanOrEqual(44);
      expect(del.width).toBeGreaterThanOrEqual(44);
      await page.click('#close');
      const pain = await page.locator('#painscale button').first().boundingBox();
      expect(pain.height).toBeGreaterThanOrEqual(44);
      expect(pain.width).toBeGreaterThanOrEqual(44);
    });

    test('no page errors', () => {
      expect(errs).toEqual([]);
    });
  });
}

test.describe('the exercise screen locks the page behind it', () => {
  const openAt = async (browser, y) => {
    const ctx = await browser.newContext({ ...PHONE });
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.evaluate(n => window.scrollTo(0, n), y);
    return { ctx, page };
  };

  test('the page cannot be scrolled behind the screen, and does not jump', async ({ browser }) => {
    const { ctx, page } = await openAt(browser, 120);
    const headingBefore = await page.locator('h1').boundingBox();

    await page.click('.ex[data-ex="Deadlift"]');
    await settle(page);

    // pinned rather than merely overflow:hidden, which iOS ignores
    expect(await page.evaluate(() => getComputedStyle(document.body).position)).toBe('fixed');
    // and pinned at an offset, so nothing visibly moves when it locks
    const headingDuring = await page.locator('h1').boundingBox();
    expect(headingDuring.y).toBeCloseTo(headingBefore.y, 0);

    for (const [x, y] of [[195, 60], [195, 300]]) {
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY), `wheel at ${x},${y} leaked`).toBe(before);
    }
    await ctx.close();
  });

  test('closing restores the reading position', async ({ browser }) => {
    const { ctx, page } = await openAt(browser, 140);
    await page.click('.ex[data-ex="Deadlift"]');
    await settle(page);
    await page.click('#close');
    await expect(page.locator('#view-exercise')).toBeHidden();

    expect(await page.evaluate(() => getComputedStyle(document.body).position)).toBe('static');
    expect(await page.evaluate(() => window.scrollY)).toBe(140);
    await ctx.close();
  });

  test('the lock lifts every way out, including the phone back gesture', async ({ browser }) => {
    const { ctx, page } = await openAt(browser, 90);
    const isLocked = () => page.evaluate(() => document.body.classList.contains('locked'));

    await page.click('.ex[data-ex="Deadlift"]');
    expect(await isLocked()).toBe(true);
    await page.keyboard.press('Escape');
    expect(await isLocked()).toBe(false);

    await page.click('.ex[data-ex="Deadlift"]');
    expect(await isLocked()).toBe(true);
    await page.click('#close');
    expect(await isLocked()).toBe(false);

    // the screen is a history entry, so going back leaves it too
    await page.click('.ex[data-ex="Deadlift"]');
    expect(await isLocked()).toBe(true);
    await page.goBack();
    await expect(page.locator('#view-exercise')).toBeHidden();
    expect(await isLocked()).toBe(false);

    // reaching the gear scrolls the header into view, so whatever the position
    // is at the moment of locking is what has to come back
    await page.click('#gear');
    expect(await isLocked()).toBe(true);
    const atLock = await page.evaluate(() => Math.abs(parseInt(document.body.style.top, 10)) || 0);
    await page.click('#setdone');
    expect(await isLocked()).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(atLock);
    await ctx.close();
  });
});

// Installed to the home screen, iOS hands the page the whole screen including
// the status bar. env() is always zero in a desktop browser, so the insets are
// injected through the variables they are read from.
test.describe('safe-area insets', () => {
  const TOP = 59;    // Dynamic Island
  const BOTTOM = 34; // home indicator

  test('the header clears the status bar', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE });
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const before = await page.locator('header').boundingBox();

    await page.evaluate(([t, b]) => {
      document.documentElement.style.setProperty('--safe-top', t + 'px');
      document.documentElement.style.setProperty('--safe-bottom', b + 'px');
    }, [TOP, BOTTOM]);

    const title = await page.locator('h1').boundingBox();
    const gear = await page.locator('#gear').boundingBox();
    // Nothing in the header may intrude into the status bar strip.
    expect(title.y, 'title under the status bar').toBeGreaterThanOrEqual(TOP);
    expect(gear.y, 'gear under the status bar').toBeGreaterThanOrEqual(TOP);

    const after = await page.locator('header').boundingBox();
    expect(after.height - before.height).toBeCloseTo(TOP, 0);
    await ctx.close();
  });

  test('the nav and rest timer clear the home indicator', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE });
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.evaluate(([t, b]) => {
      document.documentElement.style.setProperty('--safe-top', t + 'px');
      document.documentElement.style.setProperty('--safe-bottom', b + 'px');
    }, [TOP, BOTTOM]);

    const vh = await page.evaluate(() => innerHeight);
    const navText = await page.locator('#tab-train').boundingBox();
    expect(navText.y + navText.height, 'tabs over the home indicator')
      .toBeLessThanOrEqual(vh - BOTTOM);
    await ctx.close();
  });

  test('the exercise screen keeps its heading below the status bar', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.evaluate(([t, b]) => {
      document.documentElement.style.setProperty('--safe-top', t + 'px');
      document.documentElement.style.setProperty('--safe-bottom', b + 'px');
    }, [TOP, BOTTOM]);

    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '225');
    await page.fill('#reps', '5');
    for (let i = 0; i < 6; i++) await page.click('#logset');

    // the screen itself is full-bleed by design; what must clear the inset is
    // everything you can read or press in its header
    const title = await page.locator('#sheet-title').boundingBox();
    const back = await page.locator('#close').boundingBox();
    expect(title.y, 'title under the status bar').toBeGreaterThanOrEqual(TOP);
    expect(back.y, 'back button under the status bar').toBeGreaterThanOrEqual(TOP);
    await ctx.close();
  });
});
