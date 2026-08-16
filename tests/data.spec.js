const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FILE_URL, phone, watchErrors, seed, blankDb } = require('./helpers');

test.describe('backup, restore and export', () => {
  test.describe.configure({ mode: 'serial' });

  let page, ctx, dir, backupPath;

  test.beforeAll(async ({ browser }) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-'));
    ctx = await phone(browser, { acceptDownloads: true });
    page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '225');
    await page.fill('#reps', '5');
    for (let i = 0; i < 5; i++) await page.click('#logset');
    await page.click('#close');
  });

  test.afterAll(async () => {
    await ctx?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a JSON backup downloads with the data intact', async () => {
    await page.click('#gear');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
    backupPath = path.join(dir, 'backup.json');
    await dl.saveAs(backupPath);

    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    expect(backup.sets).toHaveLength(5);
    expect(backup.sets.every(s => s.u === 'lb')).toBe(true);
    expect(backup.sets.every(s => s.dy === 'A')).toBe(true);
  });

  test('CSV quotes fields instead of stripping commas', async () => {
    await page.click('#setdone');
    await page.fill('#notes', 'felt "sharp", low back, set 3');
    await expect(page.locator('#notestate')).toHaveText('Note saved.');

    await page.click('#gear');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    const csvPath = path.join(dir, 'out.csv');
    await dl.saveAs(csvPath);

    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(6); // header + 5 sets
    expect(lines[0]).toContain('unit');
    expect(lines[1]).toContain('"felt ""sharp"", low back, set 3"');
  });

  test('a backup restores over wiped storage and persists', async () => {
    await page.click('#setdone');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('0/4');

    await page.click('#gear');
    await page.setInputFiles('#restorefile', backupPath);
    await expect(page.locator('#toast')).toContainText(/restored/i);
    await page.click('#setdone');
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('5/4');

    await page.reload();
    await expect(page.locator('.ex[data-ex="Deadlift"] .count')).toHaveText('5/4');
  });

  test('a file that is not a backup is rejected without losing data', async () => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{"nope":true}');
    await page.click('#gear');
    await page.setInputFiles('#restorefile', bad);
    await expect(page.locator('#toast')).toContainText(/not a valid/i);
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('logbook-v1')).sets.length)).toBe(5);
  });
});

test.describe('plate inventory', () => {
  const pressed = page => page.$$eval('#platesel button[aria-pressed="true"]',
    b => b.map(x => x.textContent.trim()));

  test('a gym with no 35s is never told to load one', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // 225 = 45 bar + 45+45 a side by default, so use a load that wants a 35
    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '205');
    await expect(page.locator('#pmtext')).toContainText('35');
    await page.click('#close');

    await page.click('#gear');
    await expect(page.locator('#platesel')).toBeVisible();
    await page.click('#platesel [data-plate="35"]');
    expect(await pressed(page)).not.toContain('35');
    await page.click('#setdone');

    await page.click('.ex[data-ex="Deadlift"]');
    await page.fill('#wt', '205');
    // 80 a side now has to come from 45 + 25 + 10 instead of 45 + 35
    await expect(page.locator('#pmtext')).not.toContainText('35');
    await expect(page.locator('#pmtext')).toContainText('25');
    await ctx.close();
  });

  test('the weight step follows the smallest plate kept', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#wup')).toHaveText('+5');   // two 2.5s
    await page.fill('#wt', '227.5');
    await expect(page.locator('#pmwarn')).toContainText(/smaller plates in settings/i);
    await page.click('#close');

    await page.click('#gear');
    await page.click('#platesel [data-plate="1.25"]');
    await page.click('#setdone');

    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#wup')).toHaveText('+2.5'); // two 1.25s
    await page.fill('#wt', '227.5');
    await expect(page.locator('#pmwarn')).toBeHidden();
    await expect(page.locator('#pmtext')).toContainText('1.25');
    await page.click('#close');

    // drop the 2.5s and 1.25s and the step doubles again
    await page.click('#gear');
    await page.click('#platesel [data-plate="1.25"]');
    await page.click('#platesel [data-plate="2.5"]');
    await page.click('#setdone');
    await page.click('.ex[data-ex="Deadlift"]');
    await expect(page.locator('#wup')).toHaveText('+10');  // two 5s
    await ctx.close();
  });

  test('the rack is per unit and the last plate cannot be removed', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('#gear');
    await page.click('#platesel [data-plate="35"]');
    expect(await pressed(page)).toEqual(['45', '25', '10', '5', '2.5']);

    // kg has its own rack, untouched by an edit made in pounds
    await page.click('[data-unit="kg"]');
    expect(await pressed(page)).toEqual(['25', '20', '15', '10', '5', '2.5']);

    for (const w of ['20', '15', '10', '5', '2.5']) await page.click(`#platesel [data-plate="${w}"]`);
    expect(await pressed(page)).toEqual(['25']);
    await page.click('#platesel [data-plate="25"]');
    await expect(page.locator('#toast')).toContainText(/keep at least one plate/i);
    expect(await pressed(page)).toEqual(['25']);

    await page.click('[data-unit="lb"]');
    expect(await pressed(page)).toEqual(['45', '25', '10', '5', '2.5']);
    await ctx.close();
  });

  test('the rack survives a reload', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await page.click('#gear');
    await page.click('#platesel [data-plate="35"]');
    await page.click('#setdone');

    await page.reload();
    await page.waitForSelector('.ex');
    await page.click('#gear');
    expect(await pressed(page)).not.toContain('35');
    await ctx.close();
  });
});

test.describe('rest alert setting', () => {
  // Count what the alert actually does rather than trusting the setting:
  // stub the oscillator and the vibrator before any app code runs.
  const instrument = page => page.addInitScript(() => {
    window.__beeps = 0;
    window.__buzzes = [];
    const AC = window.AudioContext || window.webkitAudioContext;
    class Counting extends AC {
      createOscillator() { window.__beeps++; return super.createOscillator(); }
    }
    window.AudioContext = Counting;
    window.webkitAudioContext = Counting;
    navigator.vibrate = pattern => { window.__buzzes.push(pattern); return true; };
  });

  const counts = page => page.evaluate(() => ({ beeps: window.__beeps, buzzes: window.__buzzes.length }));

  for (const [mode, sound, buzz] of [
    ['both', true, true],
    ['sound', true, false],
    ['vibrate', false, true],
    ['silent', false, false]
  ]) {
    test(`"${mode}" plays ${sound ? 'sound' : 'no sound'} and ${buzz ? 'vibrates' : 'does not vibrate'}`,
      async ({ browser }) => {
        const ctx = await phone(browser);
        const page = await ctx.newPage();
        await instrument(page);
        await page.goto(FILE_URL);
        await page.waitForSelector('.ex');

        await page.click('#gear');
        await page.selectOption('#alertsel', mode);
        await page.evaluate(() => { window.__beeps = 0; window.__buzzes = []; }); // ignore the preview
        await page.click('#testalert');
        await page.waitForTimeout(300);

        const c = await counts(page);
        expect(c.beeps > 0, 'made a sound').toBe(sound);
        expect(c.buzzes > 0, 'vibrated').toBe(buzz);
        await ctx.close();
      });
  }

  // Both ends of the range against a real timer, so "silent stayed silent"
  // cannot pass just because the timer never fired.
  for (const [mode, shouldAlert] of [['silent', false], ['both', true]]) {
    test(`a real timer honours "${mode}" and the choice survives a reload`, async ({ browser }) => {
      const ctx = await phone(browser);
      const page = await ctx.newPage();
      await instrument(page);
      // a one-second rest target, so the alert can be observed without waiting
      await page.addInitScript(m => {
        localStorage.setItem('logbook-v1', JSON.stringify({
          v: 2, sets: [], days: {}, pairs: {}, ex: { Deadlift: { rest: 1 } }, program: null,
          settings: { units: 'lb', fractional: false, transition: 30, bw: { lb: 0, kg: 0 },
                      lastDay: 'A', alert: m },
          rest: null
        }));
      }, mode);
      await page.goto(FILE_URL);
      await page.waitForSelector('.ex');

      await page.click('#gear');
      expect(await page.locator('#alertsel').inputValue()).toBe(mode);
      await page.click('#setdone');

      await page.click('.ex[data-ex="Deadlift"]');
      await page.fill('#wt', '225');
      await page.fill('#reps', '5');
      await page.click('#logset');
      await expect(page.locator('#rest')).toHaveClass(/ready/);
      await page.waitForTimeout(400);

      const c = await counts(page);
      expect(c.beeps > 0, 'made a sound').toBe(shouldAlert);
      expect(c.buzzes > 0, 'vibrated').toBe(shouldAlert);
      // the visual ready state lands either way — that is the point of silent
      await expect(page.locator('#rest')).toHaveClass(/ready/);
      await ctx.close();
    });
  }
});

test('the pain chart scales with the rating', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  const days = {};
  [1, 3, 5, 8, 10, 2, 4].forEach((v, i) => { days[`2026-08-0${i + 1}`] = { pain: v }; });
  await seed(page, blankDb({ days }));
  await page.goto(FILE_URL);
  await page.click('#tab-history');

  const bars = await page.$$eval('.painstrip div', els =>
    els.map(e => +e.getBoundingClientRect().height.toFixed(1)));
  const strip = await page.locator('.painstrip').boundingBox();
  // this used to read the day record instead of its pain value, so every bar
  // collapsed to the 2px minimum and the chart was a flat line
  expect(bars).toHaveLength(7);
  expect(bars[4]).toBeCloseTo(strip.height, 0); // pain 10 fills the strip
  expect(bars[4]).toBeGreaterThan(bars[3]);
  expect(bars[3]).toBeGreaterThan(bars[2]);
  expect(bars[0]).toBeLessThan(bars[2]);

  const label = await page.getAttribute('.painstrip', 'aria-label');
  expect(label).toContain('2026-08-05: 10');
  expect(label).not.toContain('object Object');
  await ctx.close();
});

test('blocked storage is reported, not retried forever', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    // private mode / quota exceeded
    Object.getPrototypeOf(localStorage).setItem = function () {
      throw new DOMException('QuotaExceededError');
    };
  });
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');
  await page.click('.ex[data-ex="Deadlift"]');
  await page.fill('#wt', '135');
  await page.fill('#reps', '5');
  await page.click('#logset');

  await expect(page.locator('#banners')).toContainText(/blocking saved data/i, { timeout: 10000 });
  await expect(page.locator('#toast')).not.toContainText(/retrying/i);
  await ctx.close();
});

test('a v1 database migrates', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('logbook-v1', JSON.stringify({
      sets: [{ id: 'x1', d: '2026-08-01', e: 'Deadlift', w: 315, r: 3, rir: 1, rest: 200 }],
      days: { '2026-08-01': { pain: 4, notes: 'ok' } },
      bars: { Deadlift: 45 },
      rests: { Deadlift: 240 },
      settings: { fractional: true }
    }));
  });
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');

  await page.click('#tab-history');
  await expect(page.locator('#trends')).toContainText('Deadlift');
  await expect(page.locator('#paincard')).toContainText('4.0');

  await page.click('#tab-train');
  await page.click('.ex[data-ex="Deadlift"]');
  // v1 kept bar and rest overrides in flat maps and assumed pounds
  await expect(page.locator('#bars button[aria-pressed="true"]')).toHaveText('45 bar');
  await page.click('#close');

  // v1 stored a "fractional" boolean, which was one answer to the broader
  // question the rack now asks — it has to arrive as the 1.25s being owned
  await page.click('#gear');
  expect(await page.$$eval('#platesel button[aria-pressed="true"]',
    b => b.map(x => x.textContent.trim()))).toContain('1.25');
  await ctx.close();
});
