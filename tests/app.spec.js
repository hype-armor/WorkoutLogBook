const { test, expect } = require('@playwright/test');
const { FILE_URL, phone, watchErrors } = require('./helpers');

test.describe('logging a session', () => {
  test.describe.configure({ mode: 'serial' });

  let page, errs;

  test.beforeAll(async ({ browser }) => {
    const ctx = await phone(browser);
    page = await ctx.newPage();
    errs = watchErrors(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
  });

  test.afterAll(async () => { await page?.context().close(); });

  test('a logged set survives a reload', async () => {
    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '225');
    await page.fill('#reps', '5');
    await page.click('#logset');
    await expect(page.locator('.setrow')).toHaveCount(1);
    await page.click('#close');

    await page.reload();
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('1/4');
    expect(await page.evaluate(() => !!localStorage.getItem('logbook-v1'))).toBe(true);
    // the bug this replaces left a permanent "save failed - retrying" toast
    await expect(page.locator('#toast')).not.toContainText(/failed/i);
  });

  test('the rest timer resumes after a reload', async () => {
    await expect(page.locator('#rest')).toHaveClass(/show/);
  });

  test('a set can be edited in place', async () => {
    await page.click('.ex[data-ex="Deadlift"]');
    await page.click('.setrow .tap');
    await expect(page.locator('#logset')).toHaveText('Save');
    await page.fill('#wt', '235');
    await page.click('#logset');
    await expect(page.locator('.setrow .load')).toContainText('235');
    await expect(page.locator('.setrow')).toHaveCount(1);
  });

  test('deleting a set offers an undo that works', async () => {
    await page.click('.setrow .del');
    await expect(page.locator('.setrow')).toHaveCount(0);
    await expect(page.locator('#toast')).toContainText(/undo/i);
    await page.click('#toast button');
    await expect(page.locator('.setrow')).toHaveCount(1);
  });

  test('the subtitle and toast track progress against the target', async () => {
    await expect(page.locator('#sheet-sub')).toContainText('1/4 done');
    await page.click('#logset');
    await expect(page.locator('#sheet-sub')).toContainText('2/4 done');
    await expect(page.locator('#toast')).toContainText(/set 2 of 4/i);
    for (let i = 0; i < 3; i++) await page.click('#logset');
    // past the target "set 5 of 4" would read as nonsense
    await expect(page.locator('#toast')).toContainText(/set 5 logged/i);
  });

  test('switching to kg converts existing sets rather than corrupting them', async () => {
    await page.click('#close');
    await page.click('#gear');
    await page.click('[data-unit="kg"]');
    await page.click('#setdone');
    await page.click('.ex[data-ex="Deadlift"]');
    // 235 lb is ~106.6 kg
    await expect(page.locator('.setrow .load').first()).toContainText(/10[67]/);
    await expect(page.locator('#wtlab')).toContainText('kg');
    // 5 kg, not 2.5: the step is two of the smallest plate in the rack, and a
    // default kg rack stops at 2.5s. Stepping by 2.5 kg total asked for 1.25 a
    // side, which is not loadable without plates most gyms do not stock.
    await expect(page.locator('#wup')).toHaveText('+5');
    await expect(page.locator('#bars')).toContainText('20 bar');
  });

  test('the timer docks inside the sheet and returns when it closes', async () => {
    expect(await page.evaluate(() =>
      document.querySelector('#sheet').contains(document.querySelector('#rest')))).toBe(true);
    await expect(page.locator('#scrim')).toHaveClass(/open/);
    await page.click('#close');
    expect(await page.evaluate(() =>
      document.querySelector('#rest').parentElement === document.body)).toBe(true);
  });

  test('bodyweight work scores above zero once bodyweight is set', async () => {
    await page.click('#gear');
    await page.click('[data-unit="lb"]');
    await page.fill('#bwinput', '180');
    await page.dispatchEvent('#bwinput', 'change');
    await page.click('#setdone');

    await page.click('[data-day="D"]');
    await page.click('.ex[data-ex="Pull-up"]');
    await expect(page.locator('#wtlab')).toContainText(/added/i);
    await page.fill('#wt', '0');
    await page.fill('#reps', '8');
    await page.click('#logset');
    await expect(page.locator('.setrow .load')).toContainText('BW');
    await page.click('#close');

    await page.click('#tab-history');
    const est = await page.evaluate(() => {
      const c = [...document.querySelectorAll('#trends .card')]
        .find(x => x.querySelector('h3').textContent === 'Pull-up');
      return c ? +c.querySelector('.metric b').textContent : null;
    });
    expect(est).toBeGreaterThan(0);
  });

  test('sessions can be expanded to show their sets', async () => {
    await expect(page.locator('#sessions .card')).not.toHaveCount(0);
    await page.click('#sessions .sesshead');
    await expect(page.locator('#sessions .sessline').first()).toBeVisible();
  });

  test('distance work is logged in metres and kept out of plate math', async () => {
    await page.click('#tab-train');
    await page.click('[data-day="A"]');
    await page.click('.ex[data-ex="Suitcase carry"]');
    await expect(page.locator('#repslab')).toContainText(/distance/i);
    await expect(page.locator('#platemath')).toBeHidden();
    await page.fill('#wt', '70');
    await page.fill('#reps', '40');
    await page.click('#logset');
    await expect(page.locator('.setrow .load')).toContainText('40 m');
    await page.click('#close');
  });

  test('a past date can be logged and returned from', async () => {
    await page.evaluate(() => {
      const i = document.querySelector('#dateinput');
      i.value = '2026-08-10';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#banners')).toContainText('not today');
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('0/4');
    await page.click('#banners button');
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('5/4');
  });

  test('no page errors across the whole session', () => {
    expect(errs).toEqual([]);
  });
});

test.describe('editing the program', () => {
  test.describe.configure({ mode: 'serial' });

  let page, errs;

  test.beforeAll(async ({ browser }) => {
    const ctx = await phone(browser);
    page = await ctx.newPage();
    errs = watchErrors(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    // one logged set, so we can prove a rename carries history with it
    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '315');
    await page.fill('#reps', '3');
    await page.click('#logset');
    await page.click('#close');
  });

  test.afterAll(async () => { await page?.context().close(); });

  test('exercises can be reordered', async () => {
    await page.click('#editprog');
    await expect(page.locator('.exrow .tools').first()).toBeVisible();
    const before = await page.locator('.exrow .ex .name').first().textContent();
    await page.click('.exrow:nth-child(2) [data-move="up"]');
    const after = await page.locator('.exrow .ex .name').first().textContent();
    expect(after).not.toBe(before);
  });

  test('an exercise can be added', async () => {
    await page.click('#addex');
    await page.fill('#exname', 'Hip thrust');
    await page.fill('#extarget', '3 × 12');
    await page.click('#exsave');
    await expect(page.locator('#exlist')).toContainText('Hip thrust');
  });

  test('renaming carries the logged sets with it', async () => {
    await page.click('[data-edit="Deadlift"]');
    await page.fill('#exname', 'Conventional deadlift');
    await page.click('#exsave');
    await expect(page.locator('#exlist')).toContainText('Conventional deadlift');
    await expect(page.locator('.ex[data-ex="Conventional deadlift"] .count')).toHaveText('1/4');
  });

  test('an exercise name cannot inject markup', async () => {
    await page.click('[data-edit="Conventional deadlift"]');
    await page.fill('#exname', '<img src=x onerror=window.__xss=1>');
    await page.click('#exsave');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('removing an exercise offers an undo', async () => {
    await page.click('[data-edit="Hip thrust"]');
    await page.click('#exdelete');
    await expect(page.locator('#exlist')).not.toContainText('Hip thrust');
    await expect(page.locator('#toast')).toContainText(/removed/i);
    await page.click('#toast button');
    await expect(page.locator('#exlist')).toContainText('Hip thrust');
  });

  test('no page errors while editing', () => {
    expect(errs).toEqual([]);
  });
});

test.describe('one-sided exercises get an even target', () => {
  test('the defaults are even, and say what half of them means', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // you only have two arms
    await expect(page.locator('.ex[data-ex="Suitcase carry"] .target')).toHaveText('4 × 40m');
    await page.click('.ex[data-ex="Suitcase carry"]');
    await expect(page.locator('#sheet-sub')).toContainText('4 × 40m (2 per side)');
    await page.click('#close');

    // and two legs
    await page.click('[data-day="C"]');
    await expect(page.locator('.ex[data-ex="Bulgarian split squat"] .target')).toHaveText('4 × 10');
    await page.click('.ex[data-ex="Bulgarian split squat"]');
    await expect(page.locator('#sheet-sub')).toContainText('(2 per side)');
    await ctx.close();
  });

  test('an odd target typed into the editor is rounded up', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('#editprog');
    await page.click('[data-edit="Suitcase carry"]');
    expect(await page.isChecked('#exuni')).toBe(true);
    await page.fill('#extarget', '3 × 40m');
    await page.click('#exsave');
    await expect(page.locator('#toast')).toContainText(/rounded to 4 sets/i);
    await expect(page.locator('.ex[data-ex="Suitcase carry"] .target')).toHaveText('4 × 40m');

    // an even target is left exactly as typed
    await page.click('[data-edit="Suitcase carry"]');
    await page.fill('#extarget', '6 × 30m');
    await page.click('#exsave');
    await expect(page.locator('.ex[data-ex="Suitcase carry"] .target')).toHaveText('6 × 30m');
    await ctx.close();
  });

  test('two-sided exercises are left alone', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('#editprog');
    await page.click('[data-edit="Leg curl"]');
    expect(await page.isChecked('#exuni')).toBe(false);
    await page.fill('#extarget', '3 × 12');
    await page.click('#exsave');
    // nothing unilateral about a leg curl, so 3 stays 3
    await expect(page.locator('.ex[data-ex="Leg curl"] .target')).toHaveText('3 × 12');

    // marking one as one-sided applies the rule from then on
    await page.click('[data-edit="Leg curl"]');
    await page.check('#exuni');
    await page.click('#exsave');
    await expect(page.locator('.ex[data-ex="Leg curl"] .target')).toHaveText('4 × 12');
    await ctx.close();
  });
});

test.describe('finishing a session', () => {
  test.describe.configure({ mode: 'serial' });

  let page, errs;

  const logSet = async (ex, w, r) => {
    await page.click(`.ex[data-ex="${ex}"]`);
    await page.fill('#wt', String(w));
    await page.fill('#reps', String(r));
    await page.click('#logset');
    await page.click('#close');
  };

  test.beforeAll(async ({ browser }) => {
    const ctx = await phone(browser);
    page = await ctx.newPage();
    errs = watchErrors(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
  });

  test.afterAll(async () => { await page?.context().close(); });

  test('there is nothing to finish before anything is logged', async () => {
    await expect(page.locator('#finish')).toHaveCount(0);
    await expect(page.locator('#finishwrap')).toBeEmpty();
  });

  test('the button appears with a running summary once sets exist', async () => {
    await logSet('Deadlift', 225, 5);
    await logSet('Deadlift', 225, 5);
    await logSet('Leg press', 300, 10);
    await expect(page.locator('#finish')).toBeVisible();
    // 2×225×5 + 300×10 = 5250
    await expect(page.locator('#finishwrap')).toContainText('3 sets');
    await expect(page.locator('#finishwrap')).toContainText('2 exercises');
    await expect(page.locator('#finishwrap')).toContainText('5,250 lb moved');
  });

  test('finishing records it, stops the timer and nudges for a pain rating', async () => {
    await expect(page.locator('#rest')).toHaveClass(/show/);
    await page.click('#finish');

    await expect(page.locator('.card.done')).toBeVisible();
    await expect(page.locator('#finishwrap')).toContainText('Session finished');
    await expect(page.locator('#rest')).not.toHaveClass(/show/);
    await expect(page.locator('#exlabel')).toContainText('finished');
    // pain was never rated, so the toast points at it rather than staying quiet
    await expect(page.locator('#toast')).toContainText(/rate your back pain/i);
    expect(await page.evaluate(() =>
      !!JSON.parse(localStorage.getItem('logbook-v1')).days[Object.keys(
        JSON.parse(localStorage.getItem('logbook-v1')).days)[0]].done)).toBe(true);
  });

  test('a finished session reports a duration', async () => {
    await expect(page.locator('#finishwrap')).toContainText(/\d+ min/);
  });

  test('it survives a reload', async () => {
    await page.reload();
    await page.waitForSelector('.ex');
    await expect(page.locator('.card.done')).toBeVisible();
    await expect(page.locator('#exlabel')).toContainText('finished');
  });

  test('reopening puts the button back', async () => {
    await page.click('#reopen');
    await expect(page.locator('#finish')).toBeVisible();
    await expect(page.locator('.card.done')).toHaveCount(0);
    await expect(page.locator('#exlabel')).not.toContainText('finished');
  });

  test('logging another set un-finishes a finished session', async () => {
    await page.click('#finish');
    await expect(page.locator('.card.done')).toBeVisible();
    await logSet('Leg curl', 90, 12);
    // still adding sets means the session was not over
    await expect(page.locator('#finish')).toBeVisible();
    await expect(page.locator('.card.done')).toHaveCount(0);
  });

  test('history shows the session as finished', async () => {
    await page.click('#finish');
    await page.click('#tab-history');
    await expect(page.locator('#sessions .card').first()).toContainText('finished');
    await page.click('#tab-train');
  });

  test('a different date has its own finished state', async () => {
    await page.evaluate(() => {
      const i = document.querySelector('#dateinput');
      i.value = '2026-08-10';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#finishwrap')).toBeEmpty();
    await page.click('#banners button'); // back to today
    await expect(page.locator('.card.done')).toBeVisible();
  });

  test('no page errors', () => {
    expect(errs).toEqual([]);
  });
});

test.describe('the rest timer outlives the page', () => {
  const secs = t => { const [m, s] = t.trim().split(':').map(Number); return m * 60 + s; };

  test('a reload keeps the elapsed time, not just the timer', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '225');
    await page.fill('#reps', '5');
    await page.click('#logset');
    await page.click('#close');
    await page.waitForTimeout(3000);

    const before = secs(await page.textContent('#restclock'));
    expect(before).toBeGreaterThanOrEqual(2);

    await page.reload();
    await page.waitForSelector('.ex');
    await expect(page.locator('#rest')).toHaveClass(/show/);

    // start is stored as an absolute timestamp, so the clock has to pick up
    // where it left off rather than restarting at zero
    const after = secs(await page.textContent('#restclock'));
    expect(after).toBeGreaterThanOrEqual(before);
    await expect(page.locator('#resttarget')).toHaveText('3:30 target');

    await page.waitForTimeout(2200);
    expect(secs(await page.textContent('#restclock'))).toBeGreaterThan(after);
    await ctx.close();
  });

  test('a timer abandoned mid-session is dropped, not resumed', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '225');
    await page.fill('#reps', '5');
    await page.click('#logset');
    await page.click('#close');
    await expect(page.locator('#rest')).toHaveClass(/show/);

    // saving is debounced, so the timer is not on disk the instant it starts
    await expect.poll(async () => page.evaluate(() =>
      !!JSON.parse(localStorage.getItem('logbook-v1') || '{}').rest)).toBe(true);

    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('logbook-v1'));
      db.rest.start = Date.now() - (db.rest.target + 1000) * 1000;
      localStorage.setItem('logbook-v1', JSON.stringify(db));
    });
    await page.reload();
    await page.waitForSelector('.ex');
    await expect(page.locator('#rest')).not.toHaveClass(/show/);
    await ctx.close();
  });
});

test.describe('accessibility', () => {
  test('sheets are inert when closed and trap focus when open', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const closed = await page.evaluate(() => ({
      inert: document.querySelector('#sheet').hasAttribute('inert'),
      hidden: document.querySelector('#sheet').getAttribute('aria-hidden'),
      clockLive: document.querySelector('#restclock').getAttribute('aria-live'),
      tabRole: document.querySelector('#tab-train').getAttribute('role'),
      toastRole: document.querySelector('#toast').getAttribute('role'),
      webfont: !!document.querySelector('link[href*="fonts.googleapis"]')
    }));
    expect(closed.inert).toBe(true);
    expect(closed.hidden).toBe('true');
    // the clock ticks 4x a second; as a live region it would never stop talking
    expect(closed.clockLive).toBe('off');
    expect(closed.tabRole).toBe('tab');
    expect(closed.toastRole).toBe('status');
    expect(closed.webfont).toBe(false);

    await page.click('.ex[data-ex="Leg press"]');
    const open = await page.evaluate(() => ({
      inert: document.querySelector('#sheet').hasAttribute('inert'),
      focusInside: document.querySelector('#sheet').contains(document.activeElement)
    }));
    expect(open.inert).toBe(false);
    expect(open.focusInside).toBe(true);

    await page.click('#close');
    expect(await page.evaluate(() => document.activeElement?.dataset?.ex)).toBe('Leg press');
    await ctx.close();
  });

  test('double-tap does not zoom, but pinch-zoom is still allowed', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // The controls that get tapped repeatedly are the ones that would zoom.
    await page.click('.ex[data-ex="Deadlift"]');
    const touch = await page.evaluate(() => {
      const of = s => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).touchAction : null;
      };
      return {
        body: of('body'),
        logset: of('#logset'),
        stepper: of('#wup'),
        rir: of('.plate'),
        exercise: of('.ex')
      };
    });
    for (const [where, value] of Object.entries(touch)) {
      expect(value, where).toBe('manipulation');
    }

    // Removing zoom altogether would fail WCAG 1.4.4, so the viewport must not
    // pin the scale.
    const viewport = await page.getAttribute('meta[name="viewport"]', 'content');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/);
    expect(viewport).not.toMatch(/maximum-scale/);
    await ctx.close();
  });

  test('escape closes the open sheet', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Leg press"]');
    await expect(page.locator('#sheet')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sheet')).not.toHaveClass(/open/);
    await ctx.close();
  });
});
