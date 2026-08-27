const path = require('path');
const { expect } = require('@playwright/test');

const APP_PATH = path.join(__dirname, '..', 'index.html');
const SW_PATH = path.join(__dirname, '..', 'sw.js');
// The behaviour suites run against file:// on purpose: that is a supported way
// to use the app, and it keeps the service worker out of tests that are not
// about the service worker.
const FILE_URL = 'file://' + APP_PATH;

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const phone = (browser, over = {}) => browser.newContext({ ...PHONE, ...over });

/** Collect page errors and failed responses so a test can assert on silence. */
function watchErrors(page, { ignore = [] } = {}) {
  const errs = [];
  const skip = url => ignore.some(p => (url || '').includes(p));
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // "Failed to load resource" carries no URL in its text, so match on the
    // message location instead; the response listener below reports the URL.
    if (skip(m.text()) || skip(m.location() && m.location().url)) return;
    errs.push(m.text());
  });
  page.on('response', r => { if (r.status() >= 400 && !skip(r.url())) errs.push(r.status() + ' ' + r.url()); });
  page.on('requestfailed', r => { if (!skip(r.url())) errs.push('FAILED ' + r.url()); });
  return errs;
}

/** Write a database straight into storage, before any app code runs. */
async function seed(page, db) {
  await page.addInitScript(data => {
    localStorage.setItem('logbook-v1', JSON.stringify(data));
  }, db);
}

/** A database in the current format. Migration tests pass an older `v` explicitly. */
const blankDb = (over = {}) => ({
  v: 4, sets: [], days: {}, pairs: {}, ex: {}, program: null,
  settings: { units: 'lb', fractional: false, transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A' },
  rest: null, ...over
});

const set = (d, e, w, r, rir, dy = 'A') =>
  ({ id: `${e}-${d}-${w}-${r}-${rir}`, d, e, w, r, rir, rest: 180, u: 'lb', dy });

/** Rectangles overlap. Either being absent (scrolled out of sight) is no clash. */
const overlaps = (a, b) =>
  !!a && !!b && a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;

const rects = page => page.evaluate(() => {
  // Clipped to every scrolling ancestor: an element scrolled out of its
  // container still reports a box, and that box can land underneath a control
  // it is nowhere near on screen. Comparing raw boxes called that a collision.
  const r = s => {
    const el = document.querySelector(s);
    if (!el) return null;
    let b = el.getBoundingClientRect();
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(st.overflowY + ' ' + st.overflowX)) {
        const q = p.getBoundingClientRect();
        const top = Math.max(b.top, q.top), bottom = Math.min(b.bottom, q.bottom);
        const left = Math.max(b.left, q.left), right = Math.min(b.right, q.right);
        if (bottom - top <= 0 || right - left <= 0) return null;   // out of sight
        b = { top, bottom, left, right, height: bottom - top, width: right - left };
      }
      p = p.parentElement;
    }
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height, width: b.width };
  };
  return { logset: r('#logset'), rest: r('#rest'), toast: r('#toast'), plates: r('#plates'), vh: innerHeight };
});

/**
 * Wait for a sliding sheet to stop moving. Playwright's actionability checks
 * cover clicks, but reading getBoundingClientRect mid-transition measures the
 * sheet halfway up the screen and reports a false collision.
 */
async function settle(page, selector = '#view-exercise') {
  const loc = page.locator(selector);
  await loc.waitFor({ state: 'visible' });
  let prev = Number.NaN;
  await expect.poll(async () => {
    const box = await loc.boundingBox();
    if (!box) return false;
    const still = Math.abs(box.y - prev) < 0.5;
    prev = box.y;
    return still;
  }, { timeout: 5000, intervals: [60, 60, 60, 120, 250] }).toBe(true);
}

/** The day picker is collapsed to the current day; open it if it is not already. */
async function chooseDay(page, id) {
  if (await page.locator('#daytoggle').count()) await page.click('#daytoggle');
  await page.click(`[data-day="${id}"]`);
}

module.exports = {
  chooseDay, APP_PATH, SW_PATH, FILE_URL, PHONE, phone, watchErrors, seed, blankDb, set, overlaps, rects, settle };
