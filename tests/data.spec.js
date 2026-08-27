const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FILE_URL, phone, watchErrors, seed, blankDb, set } = require('./helpers');

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

test('an odd target saved before the rule existed is corrected on load', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  // a customised program keeps its own copy, so it never saw the fixed defaults
  await page.addInitScript(() => {
    localStorage.setItem('logbook-v1', JSON.stringify({
      v: 2, sets: [], days: {}, pairs: {}, ex: {},
      program: [{ id: 'A', name: 'Lower A', tag: 'Deadlift focus', ex: [
        ['Suitcase carry', '3 × 40m'],
        ['Bulgarian split squat', '5 × 10'],
        ['Leg curl', '3 × 12']
      ]}],
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A', alert: 'both' },
      rest: null
    }));
  });
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');

  await expect(page.locator('.ex[data-ex="Suitcase carry"] .target')).toHaveText('4 × 40m');
  await expect(page.locator('.ex[data-ex="Bulgarian split squat"] .target')).toHaveText('6 × 10');
  // the two-sided one is untouched
  await expect(page.locator('.ex[data-ex="Leg curl"] .target')).toHaveText('3 × 12');
  await ctx.close();
});

test('the pain chart scales with the rating', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  const days = {};
  [1, 2, 3, 4, 5, 1, 2].forEach((v, i) => {
    days[`2026-08-0${i + 1}`] = { pains: { 'lower-back': v } };
  });
  await seed(page, blankDb({ days }));
  await page.goto(FILE_URL);
  await page.click('#tab-history');

  const bars = await page.$$eval('.painstrip div', els =>
    els.map(e => +e.getBoundingClientRect().height.toFixed(1)));
  const strip = await page.locator('.painstrip').boundingBox();
  // this used to read the day record instead of its pain value, so every bar
  // collapsed to the 2px minimum and the chart was a flat line
  expect(bars).toHaveLength(7);
  expect(bars[4]).toBeCloseTo(strip.height, 0); // the top of the scale fills the strip
  expect(bars[4]).toBeGreaterThan(bars[3]);
  expect(bars[3]).toBeGreaterThan(bars[2]);
  expect(bars[0]).toBeLessThan(bars[2]);

  const label = await page.getAttribute('.painstrip', 'aria-label');
  expect(label).toContain('Lower back');
  expect(label).toContain('2026-08-05: 5');
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
  // a v1 database rated 0-10, so its 4 lands at 2 on the current scale
  await expect(page.locator('#paincard')).toContainText('2.0');

  await page.click('#tab-train');
  await page.click('.ex[data-ex="Deadlift"]');
  // v1 kept bar and rest overrides in flat maps and assumed pounds
  await page.click('#exsettings');
  await expect(page.locator('#exbar')).toHaveValue('45');
  await page.click('#exclose');
  await page.click('#close');

  // v1 stored a "fractional" boolean, which was one answer to the broader
  // question the rack now asks — it has to arrive as the 1.25s being owned
  await page.click('#gear');
  expect(await page.$$eval('#platesel button[aria-pressed="true"]',
    b => b.map(x => x.textContent.trim()))).toContain('1.25');
  await ctx.close();
});

test.describe('data durability', () => {
  // addInitScript runs on every navigation, so without this guard a reload
  // re-seeds storage and silently undoes whatever the test just did.
  const seedSessions = (page, n, lastBackup) => page.addInitScript(([count, backup]) => {
    if (localStorage.getItem('logbook-v1')) return;
    const sets = [];
    for (let i = 0; i < count; i++) {
      const t = Date.parse('2026-06-01') + i * 86400000;
      sets.push({ id: t + 'x' + i, t, d: new Date(t).toISOString().slice(0, 10),
                  e: 'Deadlift', dy: 'A', w: 225, r: 5, rir: 2, rest: 180, u: 'lb' });
    }
    localStorage.setItem('logbook-v1', JSON.stringify({
      v: 2, sets, days: {}, pairs: {}, ex: {}, program: null,
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A',
                  alert: 'both', ...(backup ? { lastBackup: backup } : {}) },
      rest: null
    }));
  }, [n, lastBackup]);

  test('storage asks to be treated as permanent', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    const asked = [];
    await page.exposeFunction('__persistCalled', () => asked.push(1));
    await page.addInitScript(() => {
      const real = navigator.storage.persist.bind(navigator.storage);
      navigator.storage.persist = () => { window.__persistCalled(); return real(); };
    });
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    // the app is the only copy of the data, so it has to ask
    expect(asked.length).toBeGreaterThan(0);
    await ctx.close();
  });

  // Served over HTTP rather than from disk, because this one reloads. Chromium
  // does not durably carry localStorage across a rapid reload of a file:// URL
  // — the reloaded document can read a snapshot from before the write, which
  // made this test fail about once in thirty runs for reasons that had nothing
  // to do with the app. Over HTTP, as it actually ships, storage is stable.
  test('a long stretch without a backup is surfaced, and can be deferred', async ({ browser, baseURL }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seedSessions(page, 9, null);
    await page.goto(baseURL);
    await page.waitForSelector('.ex');

    await expect(page.locator('#banners')).toContainText('9 sessions since your last backup');
    await page.click('#banners [data-act="snooze"]');
    await expect(page.locator('#banners')).not.toContainText('since your last backup');

    // and it stays quiet after a reload rather than nagging every launch
    await page.reload();
    await page.waitForSelector('.ex');
    await expect(page.locator('#banners')).not.toContainText('since your last backup');
    await ctx.close();
  });

  test('a few sessions is not worth nagging about', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seedSessions(page, 3, null);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await expect(page.locator('#banners')).not.toContainText('backup');
    await ctx.close();
  });

  test('taking a backup clears the notice and is reported in settings', async ({ browser }) => {
    const ctx = await phone(browser, { acceptDownloads: true });
    const page = await ctx.newPage();
    await seedSessions(page, 12, null);
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    await expect(page.locator('#banners')).toContainText('12 sessions');

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#banners [data-act="backup"]')]);
    expect(dl.suggestedFilename()).toMatch(/^logbook-\d{8}\.json$/);
    await expect(page.locator('#banners')).not.toContainText('since your last backup');

    await page.click('#gear');
    await expect(page.locator('#datastat')).toContainText('Backed up.');
    await ctx.close();
  });
});

test('the pain chart colours by severity as well as height', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    if (localStorage.getItem('logbook-v1')) return;
    const days = {};
    // one per level above none: 0 and 1 deliberately share the dimmest step
    [1, 2, 3, 4, 5].forEach((v, i) => {
      days[`2026-08-0${i + 1}`] = { pains: { 'lower-back': v } };
    });
    localStorage.setItem('logbook-v1', JSON.stringify({
      v: 4, sets: [], days, pairs: {}, ex: {}, program: null,
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A', alert: 'both',
                  painSites: ['lower-back'] }, rest: null
    }));
  });
  await page.goto(FILE_URL);
  await page.click('#tab-history');

  const bars = await page.$$eval('.painstrip div', els => els.map(e => ({
    h: +e.getBoundingClientRect().height.toFixed(1),
    bg: getComputedStyle(e).backgroundColor
  })));
  expect(bars).toHaveLength(5);

  // one hue, getting brighter with severity — on a dark ground that reads as
  // intensity, and it survives red-green colourblindness, which a green-to-red
  // scale would not
  const lum = rgb => {
    const [r, g, b] = rgb.match(/\d+/g).map(n => +n / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const lums = bars.map(b => lum(b.bg));
  for (let i = 1; i < lums.length; i++) {
    expect(lums[i], `step ${i} is not brighter than ${i - 1}`).toBeGreaterThan(lums[i - 1]);
  }
  // height still carries the number independently of colour
  for (let i = 1; i < bars.length; i++) expect(bars[i].h).toBeGreaterThan(bars[i - 1].h);

  // and rating a day previews the colour that day will take
  await page.click('#tab-train');
  const scale = '.painsite[data-site="lower-back"]';
  await page.click(`${scale} [data-pain="5"]`);
  const chosen = await page.$eval(`${scale} [data-pain="5"]`, e => getComputedStyle(e).backgroundColor);
  expect(lum(chosen)).toBeGreaterThan(lums[0]);
  await ctx.close();
});

test('the plate diagram labels every plate and stays centred', async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.goto(FILE_URL);
  await page.waitForSelector('.ex');
  await page.click('#gear');
  await page.click('#platesel [data-plate="1.25"]');   // exercise a 4-char label
  await page.click('#setdone');
  await page.click('.ex[data-ex="Deadlift"]');

  const read = () => page.evaluate(() => {
    const svg = document.querySelector('#barsvg');
    const texts = [...svg.querySelectorAll('text')].map(t => t.textContent.trim());
    const els = [...svg.querySelectorAll('rect')];
    const xs = els.flatMap(e => { const b = e.getBBox(); return [b.x, b.x + b.width]; });
    return { texts, left: Math.min(...xs), right: Math.max(...xs), width: svg.viewBox.baseVal.width };
  });

  for (const [weight, plates] of [['95', ['25']], ['225', ['45', '45']], ['322.5', ['45', '45', '45', '2.5', '1.25']]]) {
    await page.fill('#wt', weight);
    const d = await read();
    // every plate carries its own number, and the bar carries its weight
    for (const p of plates) expect(d.texts, `${weight} lb`).toContain(p);
    expect(d.texts, 'bar weight is written on the bar').toContain('45');
    // and the whole group is centred rather than anchored to one edge
    expect(Math.abs((d.left + d.right) / 2 - d.width / 2), `${weight} lb off centre`).toBeLessThan(1);
  }

  // the label on each plate has to be legible against that plate. Matching by
  // position broke once thin plates started running their labels sideways, so
  // each label records the plate it sits on.
  const inks = await page.evaluate(() => {
    const rel = hex => {
      const c = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255)
        .map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4);
      return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
    };
    const toHex = rgb => rgb.startsWith('#') ? rgb : '#' + rgb.match(/\d+/g).slice(0,3)
      .map(n => (+n).toString(16).padStart(2,'0')).join('');
    return [...document.querySelectorAll('#barsvg text[data-on]')].map(t => {
      const a = rel(toHex(getComputedStyle(t).fill));
      const b = rel(toHex(t.dataset.on));
      const [hi, lo] = [a, b].sort((x, y) => y - x);
      return { label: t.textContent, ratio: (hi + 0.05) / (lo + 0.05) };
    });
  });
  expect(inks.length).toBeGreaterThan(0);
  for (const { label, ratio } of inks) expect(ratio, `label ${label}`).toBeGreaterThanOrEqual(4.5);

  // a heavier plate is both wider and taller, as it is in a rack
  const shapes = await page.evaluate(() =>
    [...document.querySelectorAll('#barsvg rect')]
      .map(r => ({ w: +r.getAttribute('width'), h: +r.getAttribute('height'), fill: r.getAttribute('fill') }))
      .filter(r => r.fill && r.fill.startsWith('#')));
  const big = shapes.find(r => r.h === Math.max(...shapes.map(s => s.h)));
  const small = shapes.find(r => r.h === Math.min(...shapes.map(s => s.h)));
  expect(big.w, 'a 45 should be thicker than a 1.25').toBeGreaterThan(small.w);
  expect(big.h).toBeGreaterThan(small.h);

  // the message the diagram used to carry is gone; "per side" still says it
  expect((await page.textContent('#platemath')).toLowerCase()).not.toContain('one side shown');
  await expect(page.locator('#pmtext')).toContainText(/per side/i);
  await ctx.close();
});

/* ---------- pain by site (issues #25, #26) ---------- */

test.describe.serial('pain sites', () => {
  const today = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('logbook-v1')));

  test('a v2 back rating becomes lower back rather than being dropped', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb({ v: 2, days: { '2026-08-01': { pain: 6, notes: 'sore' } } }));
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // the only site on the card is the one the old data migrated into
    expect(await page.$$eval('.painsite', els => els.map(e => e.dataset.site)))
      .toEqual(['lower-back']);

    // rate something so the migrated shape is written back
    await page.click('.painsite[data-site="lower-back"] [data-pain="2"]');
    await expect.poll(async () => (await stored(page)).v).toBe(4);
    const db = await stored(page);
    // 6 on the old 0-10 scale is 3 on the current one
    expect(db.days['2026-08-01'].pains).toEqual({ 'lower-back': 3 });
    expect(db.days['2026-08-01'].pain).toBeUndefined();
    expect(db.days['2026-08-01'].notes).toBe('sore');
    await ctx.close();
  });

  test('0-10 ratings are halved onto the 0-5 scale, once and only once', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    const days = {};
    for(let v = 0; v <= 10; v++){
      days[`2026-07-${String(v + 1).padStart(2, '0')}`] = { pains: { 'lower-back': v } };
    }
    await seed(page, blankDb({ v: 3, days }));
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const vals = async () => {
      const db = await stored(page);
      return { v: db.v, pains: Object.keys(db.days).filter(k => k.startsWith('2026-07')).sort()
        .map(k => db.days[k].pains['lower-back']) };
    };
    // a write is what commits the migrated shape to storage
    const touch = async () => {
      await page.click('.painsite[data-site="lower-back"] [data-pain="0"]');
      await page.click('.painsite[data-site="lower-back"] [data-pain="0"]');
    };
    await touch();
    const want = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
    await expect.poll(async () => (await vals()).pains).toEqual(want);
    expect((await vals()).v).toBe(4);

    // Every 0-5 rating is also a valid 0-10 one, so a migration that sniffed
    // the values instead of the version would halve this again on every load
    // until the whole history read 0.
    for(let i = 0; i < 3; i++){
      await page.reload();
      await page.waitForSelector('.ex');
      await touch();
      await expect.poll(async () => (await vals()).pains, `halved again on reload ${i + 1}`)
        .toEqual(want);
    }
    await ctx.close();
  });

  test('the scale is six buttons on one row', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const scale = '.painsite[data-site="lower-back"] [data-pain]';
    expect(await page.$$eval(scale, els => els.map(e => e.textContent.trim())))
      .toEqual(['0', '1', '2', '3', '4', '5']);
    // eleven buttons wrapped onto two rows; six fit across, so the whole scale
    // is one glance and one reach
    const rows = await page.$$eval(scale,
      els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    const box = await page.locator(scale).first().boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await ctx.close();
  });

  test('the chosen rating stays readable at every level', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // The ramp brightens with severity, so a white label goes from fine at the
    // bottom to 2.2:1 at the top. The ink is picked per step by whichever of
    // white or near-black has more contrast, the same way plate labels are.
    const pick = async v => page.evaluate(n => {
      const q = () => document.querySelector(`.painsite[data-site="lower-back"] [data-pain="${n}"]`);
      q().click();                       // re-queried: rating re-renders the card
      const cs = getComputedStyle(q());
      return { bg: cs.backgroundColor, fg: cs.color };
    }, v);
    const lum = rgb => {
      const [r, g, b] = rgb.match(/\d+/g).map(x => +x / 255)
        .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (let v = 0; v <= 5; v++) {
      const { bg, fg } = await pick(v);
      const [hi, lo] = [lum(bg), lum(fg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      expect(ratio, `rating ${v} label is ${ratio.toFixed(2)}:1 on its fill`)
        .toBeGreaterThanOrEqual(4.5);
    }
    await ctx.close();
  });

  test('a site is added, rated, and removed without touching earlier days', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb({ days: { '2026-08-01': { pains: { knee: 4 } } } }));
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    await page.click('#addsite');
    await page.check('#sitelist [data-site="knee"]');
    await page.click('#sitedone');
    await page.click('.painsite[data-site="knee"] [data-pain="3"]');
    await expect.poll(async () => (await stored(page)).days[today()]?.pains?.knee).toBe(3);

    // untracking has to clear today's rating too: the scale is the only way to
    // edit it, so hiding the scale would strand the number in the record
    await page.click('#addsite');
    await page.uncheck('#sitelist [data-site="knee"]');
    await page.click('#sitedone');
    await expect(page.locator('.painsite[data-site="knee"]')).toHaveCount(0);
    await expect.poll(async () => (await stored(page)).days[today()]?.pains?.knee).toBeUndefined();
    // but the day already recorded keeps its rating
    expect((await stored(page)).days['2026-08-01'].pains.knee).toBe(4);
    await ctx.close();
  });

  test('a rated day always shows its sites, even ones no longer tracked', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    // wrist is rated today but is not in the tracked list
    await seed(page, blankDb({
      days: { [today()]: { pains: { wrist: 4 } } },
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A',
                  alert: 'both', painSites: ['lower-back'] }
    }));
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
    expect(await page.$$eval('.painsite', els => els.map(e => e.dataset.site)))
      .toEqual(['lower-back', 'wrist']);
    await ctx.close();
  });

  test('a bilateral site carries its side forward instead of asking daily', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb({
      days: { '2026-08-01': { pains: { knee: 4 }, sides: { knee: 'l' } } },
      settings: { units: 'lb', transition: 30, bw: { lb: 0, kg: 0 }, lastDay: 'A',
                  alert: 'both', painSites: ['knee'] }
    }));
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // no side chosen for today yet
    await expect(page.locator('.painsite[data-site="knee"] [data-side="l"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await page.click('.painsite[data-site="knee"] [data-pain="4"]');
    await expect(page.locator('.painsite[data-site="knee"] [data-side="l"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await stored(page)).days[today()]?.sides?.knee).toBe('l');

    // and it can still be changed
    await page.click('.painsite[data-site="knee"] [data-side="r"]');
    await expect.poll(async () => (await stored(page)).days[today()]?.sides?.knee).toBe('r');

    // sites that do not come in pairs are not asked the question at all
    await page.click('#addsite');
    await page.check('#sitelist [data-site="neck"]');
    await page.click('#sitedone');
    await expect(page.locator('.painsite[data-site="neck"] .sidepick')).toHaveCount(0);
    await ctx.close();
  });

  test('tapping the chosen number again clears a mis-tap', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    const scale = '.painsite[data-site="lower-back"]';
    await page.click(`${scale} [data-pain="4"]`);
    await expect.poll(async () => (await stored(page)).days[today()]?.pains?.['lower-back']).toBe(4);
    await page.click(`${scale} [data-pain="4"]`);
    await expect.poll(async () =>
      (await stored(page)).days[today()]?.pains?.['lower-back']).toBeUndefined();
    await expect(page.locator(`${scale} [data-pain="4"]`)).toHaveAttribute('aria-pressed', 'false');
    await ctx.close();
  });

  test('pain logged on a day without training still shows in history', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    // one day trained, one day only rated — the rest day used to be invisible
    await seed(page, blankDb({
      sets: [set('2026-08-01', 'Deadlift', 225, 5, 2)],
      days: { '2026-08-02': { pains: { knee: 3 }, sides: { knee: 'r' } } }
    }));
    await page.goto(FILE_URL);
    await page.click('#tab-history');

    const heads = await page.$$eval('#sessions .card h3', els => els.map(e => e.textContent.trim()));
    expect(heads.some(h => /Rest day/.test(h))).toBe(true);
    await expect(page.locator('#sessions')).toContainText('Knee 3 (right)');
    await ctx.close();
  });

  test('History offers a way back to rating pain on a rest day', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.click('#tab-history');
    await page.click('#logpain');

    await expect(page.locator('#tab-train')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#dateinput')).toHaveValue(today());
    await expect(page.locator('.painsite').first()).toBeVisible();
    await ctx.close();
  });

  test('the chart shows one site at a time', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    const days = {};
    [1, 2, 3].forEach((v, i) => {
      days[`2026-08-0${i + 1}`] = { pains: { 'lower-back': v, knee: 5 - v } };
    });
    await seed(page, blankDb({ days }));
    await page.goto(FILE_URL);
    await page.click('#tab-history');

    // a knee and a lower back on one strip would imply a link the data has not
    expect(await page.$$eval('#painpick button', els => els.map(e => e.textContent.trim())))
      .toEqual(['Lower back', 'Knee']);
    const px = page => page.$$eval('.painstrip div', els => els.map(e => parseFloat(e.style.height)));
    const back = await px(page);
    await page.click('#painpick [data-site="knee"]');
    const knee = await px(page);
    // lower back climbs 1,2,3 while the knee falls 4,3,2 — two series, not one
    expect(back[0]).toBeLessThan(back[2]);
    expect(knee[0]).toBeGreaterThan(knee[2]);
    expect(knee).not.toEqual(back);
    await ctx.close();
  });

  test('the CSV carries every site and does not drop rest days', async ({ browser }, testInfo) => {
    const ctx = await phone(browser, { acceptDownloads: true });
    const page = await ctx.newPage();
    await seed(page, blankDb({
      sets: [set('2026-08-01', 'Deadlift', 225, 5, 2)],
      days: {
        '2026-08-01': { pains: { 'lower-back': 4 } },
        '2026-08-02': { pains: { knee: 3 }, sides: { knee: 'l' }, notes: 'rest day ache' }
      }
    }));
    await page.goto(FILE_URL);
    await page.click('#gear');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    const out = testInfo.outputPath('sites.csv');
    await dl.saveAs(out);

    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(lines[0]).toContain('pain_lower_back');
    expect(lines[0]).toContain('pain_knee');
    expect(lines[0]).toContain('pain_sides');
    // header + the set + the rest day, which has no set to hang a row on
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('2026-08-02');
    expect(lines[2]).toContain('knee:l');
    expect(lines[2]).toContain('rest day ache');
    await ctx.close();
  });
});

/* ---------- durability of the write itself ---------- */

test.describe.serial('saving', () => {
  const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('logbook-v1')));

  test('a change is in storage before the tab can be taken away', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // Clicking and reading back inside one task: no timer can have fired, no
    // unload event has run, nothing has been awaited. Under the old trailing
    // edge debounce the rating existed only in memory at this point, and a
    // tab killed here would have taken it.
    const seen = await page.evaluate(() => {
      document.querySelector('.painsite[data-site="lower-back"] [data-pain="4"]').click();
      return JSON.parse(localStorage.getItem('logbook-v1')).days;
    });
    expect(Object.values(seen).some(d => d.pains?.['lower-back'] === 4)).toBe(true);
    await ctx.close();
  });

  test('a burst leaves nothing waiting to be written', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // Thirty changes and then an immediate read, all inside one task. Nothing
    // is queued for later, so the last one is already stored — there is no
    // window in which the tab can go away and take it.
    const last = await page.evaluate(() => {
      // re-queried each time: rating re-renders the card, and a click on a
      // detached button never reaches the delegated handler
      for(let i = 0; i < 30; i++){
        document.querySelectorAll(
          '.painsite[data-site="lower-back"] [data-pain]')[i % 6].click();
      }
      const days = JSON.parse(localStorage.getItem('logbook-v1')).days;
      return Object.values(days).map(d => d.pains?.['lower-back'])[0];
    });
    // 30 clicks over 6 buttons ends on index 29 % 6 === 5, and no value is ever
    // visited twice in a row, so nothing toggles back off
    expect(last).toBe(5);
    await ctx.close();
  });

  test('the last change of a burst is not lost when the timer never fires', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await seed(page, blankDb());
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');

    // two changes back to back: the first writes immediately, the second is
    // coalesced — and must still be on disk once the window closes
    await page.evaluate(() => {
      document.querySelector('.painsite[data-site="lower-back"] [data-pain="1"]').click();
      document.querySelector('.painsite[data-site="lower-back"] [data-pain="5"]').click();
    });
    await expect.poll(async () => {
      const days = (await stored(page)).days;
      return Object.values(days).map(d => d.pains?.['lower-back'])[0];
    }).toBe(5);
    await ctx.close();
  });
});
