const { test, expect } = require('@playwright/test');
const { FILE_URL, phone, watchErrors , chooseDay, settle } = require('./helpers');

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
    // bar choice lives in the exercise's own settings now, not the log sheet
    await expect(page.locator('#view-exercise #bars')).toHaveCount(0);
    await page.click('#exsettings');
    await expect(page.locator('#exbar')).toHaveValue('20');
    await page.click('#exclose');
  });

  test('the timer docks into the exercise screen and returns when it closes', async () => {
    expect(await page.evaluate(() =>
      document.querySelector('#view-exercise').contains(document.querySelector('#rest')))).toBe(true);
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

    await chooseDay(page, 'D');
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
    await chooseDay(page, 'A');
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

test.describe('warm-up sets', () => {
  test.describe.configure({ mode: 'serial' });

  let page, errs;

  test.beforeAll(async ({ browser }) => {
    const ctx = await phone(browser);
    page = await ctx.newPage();
    errs = watchErrors(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Deadlift"]');
  });

  test.afterAll(async () => { await page?.context().close(); });

  test('the sheet opens on working sets and asks for reps in reserve', async () => {
    await expect(page.locator('#setkind [data-kind="work"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#rirblock')).toBeVisible();
    await expect(page.locator('#logset')).toHaveText('Log set');
  });

  test('choosing warm-up drops the reps-in-reserve question', async () => {
    await page.click('#setkind [data-kind="warm"]');
    // there is no meaningful RIR for a ramp-up set
    await expect(page.locator('#rirblock')).toBeHidden();
    await expect(page.locator('#logset')).toHaveText('Log warm-up');
  });

  test('a warm-up is listed as W and starts no rest timer', async () => {
    await page.fill('#wt', '135');
    await page.fill('#reps', '5');
    await page.click('#logset');

    await expect(page.locator('.setrow')).toHaveCount(1);
    await expect(page.locator('.setrow .idx')).toHaveText('W');
    await expect(page.locator('.setrow .rir')).toHaveText('warm-up');
    await expect(page.locator('#toast')).toContainText(/warm-up logged/i);
    // 3:30 between ramp-up sets is not something anyone wants
    await expect(page.locator('#rest')).not.toHaveClass(/show/);
  });

  test('warm-ups do not count towards the target', async () => {
    await page.fill('#wt', '185');
    await page.click('#logset');
    await expect(page.locator('.setrow')).toHaveCount(2);
    await expect(page.locator('#sheet-sub')).toContainText('0/4 done');
  });

  test('working sets number from one and do start the timer', async () => {
    await page.click('#setkind [data-kind="work"]');
    await expect(page.locator('#rirblock')).toBeVisible();
    await page.fill('#wt', '315');
    await page.click('#logset');

    await expect(page.locator('#toast')).toContainText(/set 1 of 4/i);
    await expect(page.locator('#rest')).toHaveClass(/show/);
    // the two warm-ups did not consume set numbers
    const idx = await page.$$eval('.setrow .idx', e => e.map(x => x.textContent.trim()));
    expect(idx).toEqual(['W', 'W', '1']);
    await expect(page.locator('#sheet-sub')).toContainText('1/4 done');
  });

  test('the exercise badge counts working sets only', async () => {
    await page.click('#close');
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('1/4');
  });

  test('an exercise with only warm-ups produces no trend at all', async () => {
    // est. max takes the best set, so a light warm-up could never win on its
    // own — the case that actually pollutes is an exercise you only warmed up on
    await page.click('.ex[data-ex="Leg press"]');
    await page.click('#setkind [data-kind="warm"]');
    await page.fill('#wt', '90');
    await page.fill('#reps', '10');
    await page.click('#logset');
    await page.click('#close');

    await page.click('#tab-history');
    const named = await page.$$eval('#trends .card h3', h => h.map(x => x.textContent.trim()));
    expect(named).toContain('Deadlift');       // has a working set
    expect(named).not.toContain('Leg press');  // warm-ups only
    await page.click('#tab-train');
  });

  test('the session summary separates the counts but not the volume', async () => {
    // one working set on Deadlift; two warm-ups there plus one on Leg press
    await expect(page.locator('#finishwrap')).toContainText('1 set');
    await expect(page.locator('#finishwrap')).toContainText('3 warm-ups');
    // both exercises were touched, and every set's weight was moved
    await expect(page.locator('#finishwrap')).toContainText('2 exercises');
  });

  test('a set can be reclassified after the fact', async () => {
    await page.click('.ex[data-ex="Deadlift"]');
    await page.click('.setrow:last-child .tap');       // the working set
    await expect(page.locator('#setkind [data-kind="work"]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#setkind [data-kind="warm"]');
    await page.click('#logset');

    const idx = await page.$$eval('.setrow .idx', e => e.map(x => x.textContent.trim()));
    expect(idx).toEqual(['W', 'W', 'W']);
    await expect(page.locator('#sheet-sub')).toContainText('0/4 done');

    // and back again
    await page.click('.setrow:last-child .tap');
    await page.click('#setkind [data-kind="work"]');
    await page.click('#logset');
    await expect(page.locator('#sheet-sub')).toContainText('1/4 done');
    await page.click('#close');
  });

  test('no page errors', () => {
    expect(errs).toEqual([]);
  });
});

test('the two session summaries agree, warm-ups included (#14)', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');

  const log = async (kind, w, r) => {
    await page.click(`#setkind [data-kind="${kind}"]`);
    await page.fill('#wt', String(w));
    await page.fill('#reps', String(r));
    await page.click('#logset');
  };

  await page.click('.ex[data-ex="Deadlift"]');
  await log('warm', 135, 5);   //   675
  await log('warm', 225, 5);   // 1,125
  await log('work', 315, 5);   // 1,575
  await page.click('#close');

  // Warm-up weight was moved, so it is in the volume — 675 + 1125 + 1575.
  const finish = (await page.textContent('#finishwrap')).replace(/\s+/g, ' ');
  expect(finish).toContain('3,375 lb');
  expect(finish).toContain('1 set');
  expect(finish).toContain('2 warm-ups');

  await page.click('#tab-history');
  const history = (await page.textContent('#sessions .card')).replace(/\s+/g, ' ');
  // These were computed independently and disagreed: 1,575 against 3,375, and
  // "1 set" against "3 sets". Both now come from sessionStats().
  expect(history).toContain('3,375 lb');
  expect(history).toContain('1 set + 2 warm-ups');
  await ctx.close();
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
    await chooseDay(page, 'C');
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
    await expect(page.locator('#toast')).toContainText(/rate your pain/i);
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
      inert: document.querySelector('#settings').hasAttribute('inert'),
      hidden: document.querySelector('#settings').getAttribute('aria-hidden'),
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
      hidden: document.querySelector('#view-exercise').classList.contains('hide'),
      focusInside: document.querySelector('#view-exercise').contains(document.activeElement)
    }));
    expect(open.hidden).toBe(false);
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

  test('escape leaves the exercise screen', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Leg press"]');
    await expect(page.locator('#view-exercise')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#view-exercise')).toBeHidden();
    await ctx.close();
  });
});

test.describe('seeing further back', () => {
  // 40 sessions, enough to overflow the 30 the list starts with
  const seedLong = page => page.addInitScript(() => {
    if (localStorage.getItem('logbook-v1')) return;
    const sets = [];
    for (let i = 0; i < 40; i++) {
      const t = Date.parse('2026-01-05') + i * 86400000 * 2;
      const d = new Date(t).toISOString().slice(0, 10);
      sets.push({ id: t + 'a' + i, t, d, e: 'Deadlift', dy: 'A', w: 200 + i * 2, r: 5, rir: 2, rest: 180, u: 'lb' });
      sets.push({ id: t + 'b' + i, t: t + 60000, d, e: 'Leg press', dy: 'A', w: 300, r: 10, rir: 2, rest: 120, u: 'lb' });
    }
    localStorage.setItem('logbook-v1', JSON.stringify({
      v: 2, sets, days: {}, pairs: {}, ex: {}, program: null,
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A', alert: 'both' }, rest: null
    }));
  });

  test('older sessions can be walked back to instead of vanishing', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seedLong(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#tab-history');

    // the window starts at 30 and says how much it is holding back
    await expect(page.locator('#sessions .card')).toHaveCount(30);
    await expect(page.locator('#moresessions')).toContainText('10 older');
    await page.click('#moresessions');
    await expect(page.locator('#sessions .card')).toHaveCount(40);
    await expect(page.locator('#moresessions')).toHaveCount(0);
    await ctx.close();
  });

  test('the trend arc can be widened past eight sessions', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seedLong(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#tab-history');

    await expect(page.locator('#trendlabel')).toContainText('last 8 sessions');
    await expect(page.locator('#trends .card').first()).toContainText('over 8 sessions');

    await page.click('#trendspan [data-span="all"]');
    await expect(page.locator('#trendlabel')).toContainText('every session');
    await expect(page.locator('#trends .card').first()).toContainText('over 40 sessions');
    await ctx.close();
  });

  test('a trend card opens the sets behind it', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seedLong(page);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#tab-history');

    await page.click('#trends .trendcard[data-ex="Deadlift"]');
    await expect(page.locator('#exhist')).toHaveClass(/open/);
    await expect(page.locator('#exhist-title')).toHaveText('Deadlift');
    await expect(page.locator('#exhist-sub')).toContainText('40 sessions');
    // every session it was trained, newest first, with the working weight
    await expect(page.locator('.exhistday')).toHaveCount(40);
    await expect(page.locator('.exhistday').first()).toContainText('278×5');
    await ctx.close();
  });
});

test.describe('program shape', () => {
  test('days can be renamed, added and removed', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('#editprog');
    await expect(page.locator('#dayedit')).toBeVisible();
    await page.fill('#dayname', 'Pull day');
    await expect(page.locator('.day[aria-pressed="true"] b')).toHaveText('Pull day');

    await expect(page.locator('.day')).toHaveCount(4);
    await page.click('#addday');
    await expect(page.locator('.day')).toHaveCount(5);
    await expect(page.locator('.day[aria-pressed="true"] b')).toHaveText('Day 5');
    // a fresh day starts empty rather than inheriting anything
    await expect(page.locator('#exlist')).toContainText('No exercises in this day yet');

    await page.click('#delday');
    await expect(page.locator('.day')).toHaveCount(4);
    await expect(page.locator('#toast')).toContainText(/day deleted/i);
    await page.click('#toast button');           // undo
    await expect(page.locator('.day')).toHaveCount(5);
    await ctx.close();
  });

  test('an exercise can be logged for today without joining the program', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // Front squat lives in Lower B; the rack for today's work is taken
    await expect(page.locator('.ex[data-ex="Front squat"]')).toHaveCount(0);
    await page.click('#logother');
    await page.fill('#pickfilter', 'front');
    await page.click('#picklist [data-pick="Front squat"]');

    await expect(page.locator('#sheet-title')).toHaveText('Front squat');
    await expect(page.locator('#sheet-sub')).toContainText('logged for today only');
    await page.fill('#wt', '185');
    await page.fill('#reps', '5');
    await page.click('#logset');
    await page.click('#close');

    // it shows up for today, marked as not belonging to this day
    const extra = page.locator('.ex.extra[data-ex="Front squat"]');
    await expect(extra).toBeVisible();
    await expect(extra).toContainText('Not in Lower A');
    await expect(extra.locator('.count')).toHaveText('1');

    // and Lower B is unchanged — this was a one-off, not a program edit
    await chooseDay(page, 'C');
    await expect(page.locator('#exlist')).toContainText('Front squat');
    await chooseDay(page, 'A');
    await page.reload();
    await page.waitForSelector('.ex');
    await expect(page.locator('.ex.extra[data-ex="Front squat"]')).toBeVisible();
    await ctx.close();
  });
});

test.describe('PWA affordances', () => {
  test('a manifest shortcut lands on the view it names', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL + '?view=history');
    await page.waitForSelector('#view-history:not(.hide)');
    await expect(page.locator('#tab-history')).toHaveAttribute('aria-selected', 'true');

    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await expect(page.locator('#tab-train')).toHaveAttribute('aria-selected', 'true');
    await ctx.close();
  });

  test('a background notification fires only when it would tell you something', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const counts = await page.evaluate(() => {
      const Real = window.Notification;
      let made = 0;
      window.Notification = function () { made++; this.close = () => {}; };
      window.Notification.permission = 'granted';
      const at = (vis, notify) => {
        db.settings.notify = notify;
        Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
        const before = made;
        fireAlert(false);
        return made - before;
      };
      const out = {
        backgroundedAndOn: at('hidden', true),
        // on screen the timer already turned green, so a banner is noise
        onScreen: at('visible', true),
        settingOff: at('hidden', false)
      };
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      window.Notification = Real;
      return out;
    });

    expect(counts.backgroundedAndOn).toBe(1);
    expect(counts.onScreen).toBe(0);
    expect(counts.settingOff).toBe(0);
    await ctx.close();
  });
});

test.describe('what the fields start at', () => {
  test('reps come from the target, weight from the bar when nothing is logged', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // an empty bar already weighs 45, so that is the floor, not zero
    await page.click('.ex[data-ex="Deadlift"]');          // target 4 × 4, 45 bar
    await expect(page.locator('#reps')).toHaveValue('4');
    await expect(page.locator('#wt')).toHaveValue('45');
    await expect(page.locator('#pmtext')).toContainText(/empty bar/i);
    await page.click('#close');

    // a leg press is counted per side — there is no bar to start from
    await page.click('.ex[data-ex="Leg press"]');
    await expect(page.locator('#wt')).toHaveValue('0');
    await page.click('#close');

    // and neither is a machine with no plate math at all
    await page.click('.ex[data-ex="Leg curl"]');          // target 3 × 12
    await expect(page.locator('#reps')).toHaveValue('12');
    await expect(page.locator('#wt')).toHaveValue('0');
    await page.click('#close');

    await page.click('.ex[data-ex="Suitcase carry"]');    // target 4 × 40m
    await expect(page.locator('#reps')).toHaveValue('40');
    await ctx.close();
  });

  test('the starting bar follows the exercise and the unit', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await chooseDay(page, 'C');
    await page.click('.ex[data-ex="Trap bar deadlift"]'); // 55 trap, not 45
    await expect(page.locator('#wt')).toHaveValue('55');
    await page.click('#close');

    await page.click('#gear');
    await page.click('[data-unit="kg"]');
    await page.click('#setdone');
    await page.click('.ex[data-ex="Trap bar deadlift"]');
    await expect(page.locator('#wt')).toHaveValue('25');
    await ctx.close();
  });

  test('bodyweight work still starts at zero added weight', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await chooseDay(page, 'D');
    await page.click('.ex[data-ex="Pull-up"]');
    await expect(page.locator('#wtlab')).toContainText(/added/i);
    await expect(page.locator('#wt')).toHaveValue('0');
    await ctx.close();
  });

  test('a target with no number falls back to what was done before', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await chooseDay(page, 'D');

    await page.click('.ex[data-ex="Pull-up"]');           // target 4 × max
    await expect(page.locator('#reps')).toHaveValue('');
    await page.fill('#wt', '0');
    await page.fill('#reps', '9');
    await page.click('#logset');
    await page.click('#close');

    await page.reload();
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Pull-up"]');
    await expect(page.locator('#reps')).toHaveValue('9');
    await ctx.close();
  });

  test('a later session opens at last weight plus the progression', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    // one working set of 225 on an earlier day
    await page.addInitScript(() => {
      if (localStorage.getItem('logbook-v1')) return;
      const t = Date.parse('2026-06-01');
      localStorage.setItem('logbook-v1', JSON.stringify({
        v: 2, sets: [{ id: t + 'a', t, d: '2026-06-01', e: 'Deadlift', dy: 'A', w: 225, r: 4, rir: 2, rest: 180, u: 'lb' }],
        days: {}, pairs: {}, ex: {}, program: null,
        settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A', alert: 'both' }, rest: null
      }));
    });
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await chooseDay(page, 'A');   // last session was not today, so it opened on the next day

    // default progression is the smallest jump the rack allows: two 2.5s
    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#wt')).toHaveValue('230');

    // and once a set is in today, the next one repeats it rather than climbing
    await page.click('#logset');
    await page.click('#close');
    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#wt')).toHaveValue('230');
    await ctx.close();
  });

  test('progression is adjustable per exercise', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      if (localStorage.getItem('logbook-v1')) return;
      const t = Date.parse('2026-06-01');
      localStorage.setItem('logbook-v1', JSON.stringify({
        v: 2, sets: [{ id: t + 'a', t, d: '2026-06-01', e: 'Deadlift', dy: 'A', w: 225, r: 4, rir: 2, rest: 180, u: 'lb' }],
        days: {}, pairs: {}, ex: {}, program: null,
        settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A', alert: 'both' }, rest: null
      }));
    });
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await chooseDay(page, 'A');

    await page.click('.ex[data-ex="Deadlift"]');
    // the gear reaches this exercise's own settings from the logging sheet
    await page.click('#exsettings');
    await expect(page.locator('#exprog')).toHaveAttribute('placeholder', '5');
    await page.fill('#exprog', '10');
    await page.click('#exsave');

    // the sheet behind it picks the change up without being reopened
    await expect(page.locator('#wt')).toHaveValue('235');
    await page.click('#close');

    // and it is per exercise, not global
    await page.click('.ex[data-ex="Leg press"]');
    await page.click('#exsettings');
    await expect(page.locator('#exprog')).toHaveValue('');
    await ctx.close();
  });
});

test.describe('the exercise is a screen, not a sheet', () => {
  test('selecting an exercise pushes a screen with back navigation', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await expect(page.locator('#view-exercise')).toBeHidden();
    await expect(page.locator('nav')).toBeVisible();

    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#view-exercise')).toBeVisible();
    // it takes over rather than floating above: no scrim, no tab bar
    await expect(page.locator('#scrim')).not.toHaveClass(/open/);
    await expect(page.locator('nav')).toBeHidden();
    await expect(page.locator('#sheet-title')).toHaveText('Deadlift');
    await expect(page.locator('#close')).toBeVisible();

    await page.click('#close');
    await expect(page.locator('#view-exercise')).toBeHidden();
    await expect(page.locator('nav')).toBeVisible();
    await ctx.close();
  });

  test('the phone back gesture leaves the screen instead of the app', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#view-exercise')).toBeVisible();

    await page.goBack();
    await expect(page.locator('#view-exercise')).toBeHidden();
    await expect(page.locator('.ex[data-ex="Deadlift"]')).toBeVisible();
    // still on the app, not backed out of it
    await expect(page.locator('nav')).toBeVisible();
    await ctx.close();
  });

  test('leaving by the back button does not strand a history entry', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const depth = () => page.evaluate(() => history.length);
    const cycle = async () => {
      await page.click('.ex[data-ex="Deadlift"]');
      await expect(page.locator('#view-exercise')).toBeVisible();
      await page.click('#close');
      await expect(page.locator('#view-exercise')).toBeHidden();
      return depth();
    };

    // back() moves the pointer rather than dropping the entry, so length is not
    // the measure — what matters is that opening and closing repeatedly does
    // not pile up entries to press back through later
    const first = await cycle();
    expect(await cycle()).toBe(first);
    expect(await cycle()).toBe(first);
    expect(await page.evaluate(() => history.state && history.state.screen)).not.toBe('exercise');
    await ctx.close();
  });

  test('logging still works on the screen, action stays put', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Deadlift"]');

    await page.fill('#wt', '225');
    await page.fill('#reps', '5');
    for (let i = 0; i < 6; i++) await page.click('#logset');
    await expect(page.locator('.setrow')).toHaveCount(6);

    const g = await page.evaluate(() => {
      const b = document.querySelector('#logset').getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, vh: innerHeight };
    });
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeLessThanOrEqual(g.vh + 0.5);

    await page.click('#close');
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('6/4');
    await ctx.close();
  });
});

test.describe('opening a sheet does not summon the keyboard', () => {
  test('the exercise picker lands on its heading, with the list ready to scroll', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#logother');

    // Focusing the search box raises the keyboard, and on iOS that leaves a
    // position:fixed sheet anchored behind it while the page scrolls to chase
    // the caret — the list is shoved off screen before you have read a name.
    expect(await page.evaluate(() => document.activeElement.id)).toBe('picker-title');
    await expect(page.locator('#picklist .ex').first()).toBeVisible();
    // the sheet slides in; measuring mid-transition reads it still off screen
    await settle(page, '#picker');
    expect(await page.$$eval('#picklist .ex', els => els.length)).toBeGreaterThan(5);

    // and the sheet still reaches the bottom of the screen, unshifted
    const vh = await page.evaluate(() => innerHeight);
    const sheet = await page.locator('#picker').boundingBox();
    expect(Math.round(sheet.y + sheet.height)).toBe(vh);
    await ctx.close();
  });

  test('the search box shows it is focused the moment it is tapped', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#logother');
    await page.click('#pickfilter');

    expect(await page.evaluate(() => document.activeElement.id)).toBe('pickfilter');
    const ring = await page.$eval('#pickfilter', e => {
      const c = getComputedStyle(e);
      return { w: c.outlineWidth, style: c.outlineStyle };
    });
    // nothing should have to be typed before the box looks active
    expect(ring.style).not.toBe('none');
    expect(parseFloat(ring.w)).toBeGreaterThanOrEqual(2);

    await page.fill('#pickfilter', 'dead');
    const hits = await page.$$eval('#picklist .ex', els => els.map(e => e.textContent));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => /dead/i.test(h))).toBe(true);
    await ctx.close();
  });

  test('the editor asks for a name only when there is not one yet', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // the gear on an exercise you are already logging: the name is the one
    // thing you are not there to change
    await page.click('.ex[data-ex="Deadlift"]');
    await page.click('#exsettings');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('exsheet-title');
    await page.click('#exclose');
    await page.click('#close');

    // adding one starts with typing its name, so the keyboard is wanted
    await page.click('#editprog');
    await page.click('#addex');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('exname');
    await ctx.close();
  });

  test('a sheet lifts clear of the keyboard instead of hiding behind it', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#logother');
    await settle(page, '#picker');

    const geo = () => page.locator('#picker').boundingBox();
    const vh = await page.evaluate(() => innerHeight);
    const shut = await geo();
    expect(Math.round(shut.y + shut.height)).toBe(vh);

    // The real keyboard cannot be raised here, so drive the variable the
    // visualViewport listener sets. What is under test is that the layout
    // answers it at all: without this the sheet keeps its bottom edge behind
    // the keys and the list becomes unreachable.
    await page.evaluate(() => document.documentElement.style.setProperty('--kb', '300px'));
    const up = await geo();
    expect(Math.round(up.y + up.height), 'sheet still behind the keyboard').toBe(vh - 300);
    expect(up.height, 'sheet did not shrink to fit').toBeLessThan(shut.height);
    expect(up.y, 'sheet pushed off the top').toBeGreaterThanOrEqual(0);

    await page.evaluate(() => document.documentElement.style.setProperty('--kb', '0px'));
    const back = await geo();
    expect(Math.round(back.y + back.height)).toBe(vh);
    expect(Math.round(back.height)).toBe(Math.round(shut.height));
    await ctx.close();
  });
});
