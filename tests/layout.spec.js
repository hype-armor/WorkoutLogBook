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
      await expect(page.locator('#sheet')).toHaveClass(/open/);
      await settle(page);
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
      await settle(page);
      const { logset, vh } = await rects(page);
      expect(logset.top).toBeGreaterThanOrEqual(0);
      expect(logset.bottom).toBeLessThanOrEqual(vh + 0.5);
    });

    test('the rest timer covers none of the controls', async () => {
      await settle(page);
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
