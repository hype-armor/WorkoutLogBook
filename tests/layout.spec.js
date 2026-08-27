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

    test('the steppers give their width to the buttons, not the value', async () => {
      const m = await page.evaluate(() => {
        const bb = s => { const r = document.querySelector(s).getBoundingClientRect();
          return { w: r.width, h: r.height }; };
        return { down: bb('#wdown'), up: bb('#wup'), input: bb('#wt') };
      });
      // the buttons are what gets tapped between every set
      for (const [name, b] of [['−', m.down], ['+', m.up]]) {
        expect(b.h, `${name} height`).toBeGreaterThanOrEqual(56);
        expect(b.w, `${name} width`).toBeGreaterThanOrEqual(88);
      }
      // and together they take more room than the value, which holds four or
      // five characters
      expect(m.down.w + m.up.w).toBeGreaterThan(m.input.w);

      // narrower, but not so narrow it clips a real load
      for (const v of ['5', '322.5', '1002.5', '999.75']) {
        await page.fill('#wt', v);
        const clipped = await page.evaluate(() => {
          const i = document.querySelector('#wt');
          return i.scrollWidth > i.clientWidth + 1;
        });
        expect(clipped, `${v} is clipped`).toBe(false);
      }
      await page.fill('#wt', '225');
    });

    test('touch targets are big enough to hit mid-set', async () => {
      const del = await page.locator('.setrow .del').first().boundingBox();
      expect(del.height).toBeGreaterThanOrEqual(44);
      expect(del.width).toBeGreaterThanOrEqual(44);
      await page.click('#close');
      const pain = await page.locator('.painsite .pain button').first().boundingBox();
      expect(pain.height).toBeGreaterThanOrEqual(44);
      expect(pain.width).toBeGreaterThanOrEqual(44);
      // the side tag is secondary, but it is still a target you hit with a thumb
      await page.click('#addsite');
      await page.check('#sitelist [data-site="knee"]');
      await page.click('#sitedone');
      const side = await page.locator('.sidepick button').first().boundingBox();
      expect(side.height).toBeGreaterThanOrEqual(44);
      expect(side.width).toBeGreaterThanOrEqual(44);
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

test('button text cannot be selected, but fields still can', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE });
  const page = await ctx.newPage();
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');
  await page.click('.ex[data-ex="Deadlift"]');
  await page.click('#logset');

  // Triple-click is the bluntest way to ask for a selection; holding a stepper
  // to repeat it is the way this actually shows up on a phone.
  // Only controls that stay put: triple-clicking one that navigates lands the
  // second and third clicks on whatever is underneath, which selects that
  // instead and says nothing about the button.
  for (const sel of ['#wup', '#wdown', '#logset', '.plate', '#setkind button', '.setrow .tap']) {
    await page.click(sel, { clickCount: 3 });
    const got = await page.evaluate(() => document.getSelection().toString());
    expect(got, `${sel} selected "${got}"`).toBe('');
  }

  // every control reports it, so a new button inherits the behaviour
  const styles = await page.evaluate(() =>
    ['#wup', '#logset', '.plate', '#tab-train', '.ex', '.setrow .del', '#close']
      .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect]));
  for (const [sel, v] of styles) expect(v, sel).toBe('none');

  // the fields you type into are untouched — notes are prose you may want to edit
  await page.click('#close');
  await page.fill('#notes', 'felt sharp on set three');
  await page.click('#notes', { clickCount: 3 });
  const picked = await page.evaluate(() => {
    const t = document.querySelector('#notes');
    return t.value.slice(t.selectionStart, t.selectionEnd);
  });
  expect(picked).toBe('felt sharp on set three');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#wt')).userSelect)).toBe('text');
  await ctx.close();
});

test.describe('what the exercise list says at a glance', () => {
  const seed = page => page.addInitScript(() => {
    if (localStorage.getItem('logbook-v1')) return;
    const iso = new Date().toISOString().slice(0, 10);
    const t = Date.now();
    const mk = (e, w, i) => ({ id: e + i, t: t - i * 60000, d: iso, e, dy: 'A', w, r: 5, rir: 2, rest: 180, u: 'lb' });
    // Deadlift finished (4 of 4), Leg press started (1 of 3), rest untouched
    const sets = [mk('Deadlift', 315, 1), mk('Deadlift', 315, 2), mk('Deadlift', 315, 3),
                  mk('Deadlift', 315, 4), mk('Leg press', 300, 5)];
    localStorage.setItem('logbook-v1', JSON.stringify({
      v: 2, sets, days: {}, pairs: {}, ex: {}, program: null,
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A', alert: 'both' }, rest: null
    }));
  });

  test('started, finished and untouched are told apart, and next is marked', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE });
    const page = await ctx.newPage();
    await seed(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const cls = async ex => (await page.getAttribute(`.ex[data-ex="${ex}"]`, 'class')).split(/\s+/);
    // the stripe used to go green the moment an exercise was started, which
    // said "done" while the badge beside it said "in progress"
    expect(await cls('Deadlift')).toEqual(expect.arrayContaining(['done', 'full']));
    expect(await cls('Leg press')).toEqual(expect.arrayContaining(['done']));
    expect(await cls('Leg press')).not.toContain('full');
    expect(await cls('Leg curl')).not.toContain('done');

    // exactly one row is marked as what to do next, and it is the first unfinished
    const next = await page.$$eval('.ex.next', e => e.map(x => x.dataset.ex));
    expect(next).toEqual(['Leg press']);
    await ctx.close();
  });

  test('every row state keeps its text readable', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE });
    const page = await ctx.newPage();
    await seed(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // dimming a finished row with opacity took its target text to 2.90:1
    const worst = await page.evaluate(() => {
      const rel = c => {
        const [r, g, b] = c.match(/[\d.]+/g).map(Number).slice(0, 3)
          .map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const onPage = (c, alpha) => {          // composite over the page colour
        const page = [10, 11, 19];
        const p = c.match(/[\d.]+/g).map(Number).slice(0, 3);
        return `rgb(${p.map((v, i) => v * alpha + page[i] * (1 - alpha)).join(',')})`;
      };
      let worst = 99;
      for (const row of document.querySelectorAll('.ex')) {
        const a = +getComputedStyle(row).opacity;
        const bg = onPage(getComputedStyle(row).backgroundColor.startsWith('rgba(0, 0, 0, 0')
          ? 'rgb(20,22,32)' : 'rgb(20,22,32)', 1);
        for (const el of row.querySelectorAll('.name, .target')) {
          const ink = onPage(getComputedStyle(el).color, a);
          const [hi, lo] = [rel(ink), rel(bg)].sort((x, y) => y - x);
          worst = Math.min(worst, (hi + 0.05) / (lo + 0.05));
        }
      }
      return worst;
    });
    expect(worst).toBeGreaterThanOrEqual(4.5);
    await ctx.close();
  });
});

test('the day picker folds away once a session is chosen', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE });
  const page = await ctx.newPage();
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');

  const pickerHeight = () => page.locator('#days').boundingBox().then(b => b.height);
  const firstExerciseY = () => page.locator('.ex').first().boundingBox().then(b => b.y);

  // collapsed to the day you are on, so the exercises start higher up
  await expect(page.locator('#daytoggle')).toBeVisible();
  await expect(page.locator('.day')).toHaveCount(0);
  const shut = await pickerHeight();
  const highUp = await firstExerciseY();

  await page.click('#daytoggle');
  await expect(page.locator('.day')).toHaveCount(4);
  const open = await pickerHeight();
  expect(open).toBeGreaterThan(shut);
  expect(await firstExerciseY()).toBeGreaterThan(highUp);

  // choosing folds it again and gives the room back
  await page.click('[data-day="C"]');
  await expect(page.locator('.day')).toHaveCount(0);
  await expect(page.locator('.daynow b')).toHaveText('Lower B');
  expect(await firstExerciseY()).toBeCloseTo(highUp, 0);
  await expect(page.locator('#exlabel')).toContainText('Lower B');

  // editing the program needs every day on screen, so it stays open there
  await page.click('#editprog');
  await expect(page.locator('.day')).toHaveCount(4);
  await page.click('#editprog');
  await expect(page.locator('.day')).toHaveCount(0);
  await ctx.close();
});
