const { test, expect } = require('@playwright/test');
const { FILE_URL, SYNC_URL, phone } = require('./helpers');

// The merge, on its own, with no server anywhere. What is being checked is that
// a record can be taken apart and put back, and that the higher clock wins
// whichever order the two arrive in.
test.describe('merging records', () => {
  let ctx, page;
  test.beforeAll(async ({ browser }) => {
    ctx = await phone(browser);
    page = await ctx.newPage();
    await page.goto(FILE_URL);
    await page.waitForSelector('.ex');
  });
  test.afterAll(async () => { await ctx.close(); });

  test('every kind of record survives the round trip', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      for (const [key, value] of records(db)) {
        const fresh = blank();
        putRecord(fresh, key, JSON.parse(JSON.stringify(value ?? null)));
        out[key] = JSON.stringify(records(fresh).get(key) ?? null) === JSON.stringify(value ?? null);
      }
      return out;
    });
    const wrong = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
    expect(wrong, 'records that did not come back the same').toEqual([]);
    expect(Object.keys(r).length).toBeGreaterThan(5);
  });

  test('a record can be dropped by name', async () => {
    const gone = await page.evaluate(() => {
      const d = blank();
      putRecord(d, 'set:x1', { id: 'x1', d: '2026-01-01', e: 'Deadlift', w: 100, r: 5 });
      putRecord(d, 'day:2026-01-01', { notes: 'hi' });
      putRecord(d, 'ex:Deadlift', { rest: 240 });
      const before = [...records(d).keys()].length;
      dropRecord(d, 'set:x1');
      dropRecord(d, 'day:2026-01-01');
      dropRecord(d, 'ex:Deadlift');
      return { before, after: [...records(d).keys()].length, sets: d.sets.length };
    });
    expect(gone.before - gone.after).toBe(3);
    expect(gone.sets).toBe(0);
  });

  test('the higher clock wins, whichever way round it arrives', async () => {
    const r = await page.evaluate(() => {
      const mk = at => ({ key: 'day:2026-05-05', hlc: at, value: { notes: at }, deleted: false });
      const older = mk('0000000abc:0000:aaaaaaaa'), newer = mk('0000000fff:0000:aaaaaaaa');

      db.days = {}; db.rev = {}; shadow = snapshot(db);
      mergeIncoming([older]); mergeIncoming([newer]);
      const forwards = db.days['2026-05-05'].notes;

      db.days = {}; db.rev = {}; shadow = snapshot(db);
      mergeIncoming([newer]); mergeIncoming([older]);
      const backwards = db.days['2026-05-05'].notes;

      return { forwards, backwards, clock: db.rev['day:2026-05-05'].h };
    });
    expect(r.forwards).toBe(r.backwards);
    expect(r.forwards).toBe('0000000fff:0000:aaaaaaaa');
    expect(r.clock).toBe('0000000fff:0000:aaaaaaaa');
  });

  test('an equal clock is not newer', async () => {
    const same = await page.evaluate(() => {
      const hlc = '0000000abc:0000:aaaaaaaa';
      db.days = {}; db.rev = {}; shadow = snapshot(db);
      mergeIncoming([{ key: 'day:2026-06-06', hlc, value: { notes: 'first' } }]);
      const out = mergeIncoming([{ key: 'day:2026-06-06', hlc, value: { notes: 'second' } }]);
      return { notes: db.days['2026-06-06'].notes, applied: out.applied, skipped: out.skipped };
    });
    // Two writes with the same clock are the same write: the clock carries the
    // device that made it.
    expect(same.notes).toBe('first');
    expect(same.applied).toBe(0);
    expect(same.skipped).toBe(1);
  });

  test('a record kind this version has never heard of is ignored, not fatal', async () => {
    const r = await page.evaluate(() => {
      db.rev = {}; shadow = snapshot(db);
      const out = mergeIncoming([
        { key: 'sleep:2026-07-07', hlc: '0000000abc:0000:aaaaaaaa', value: { hours: 8 } },
        { key: 'day:2026-07-07', hlc: '0000000abc:0000:aaaaaaaa', value: { notes: 'ok' } }
      ]);
      return { applied: out.applied, day: db.days['2026-07-07']?.notes, keys: Object.keys(db.rev) };
    });
    // A newer app may sync a kind this one does not have. Dropping it is
    // recoverable; throwing in the middle of a merge is not.
    expect(r.day).toBe('ok');
    expect(r.keys).toContain('day:2026-07-07');
  });

  test('what arrives from the server is not stamped as a local edit', async () => {
    const r = await page.evaluate(async () => {
      const hlc = '0000000abc:0000:bbbbbbbb';
      db.days = {}; db.rev = {}; shadow = snapshot(db);
      mergeIncoming([{ key: 'day:2026-08-08', hlc, value: { notes: 'theirs' } }]);
      await save();
      // Without refreshing the shadow, the next save reads the incoming values
      // as things this phone just typed, restamps them, and pushes them back.
      return db.rev['day:2026-08-08'].h;
    });
    expect(r).toBe('0000000abc:0000:bbbbbbbb');
  });
});

// Two browsers, one server, no stubs. This is the part that can lose training
// data, so it is tested against the thing that will actually run.
test.describe('two devices', () => {
  test.describe.configure({ mode: 'serial' });

  const handle = () => 'h' + Math.random().toString(36).slice(2, 10);

  /** A page with sync switched on, joined to `name`, created if `join` is false. */
  async function device(browser, name, join = false) {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await page.goto(SYNC_URL);
    await page.waitForSelector('.ex');
    const out = await page.evaluate(([h, j]) =>
      syncStart({ handle: h, passphrase: 'a long enough passphrase', join: j })
        .then(r => ({ ok: true, ...r })).catch(e => ({ ok: false, err: e.message })), [name, join]);
    if (!out.ok) throw new Error('sync start failed: ' + out.err);
    return { ctx, page, close: () => ctx.close() };
  }

  const logSet = (page, weight) => page.evaluate(w => {
    const id = 'set-' + w + '-' + Math.random().toString(36).slice(2, 6);
    db.sets.push({ id, t: Date.now(), d: todayISO(), e: 'Deadlift', dy: 'A',
                   w, r: 5, rir: 2, rest: null, u: 'lb' });
    return save().then(() => id);
  }, weight);

  const sync = page => page.evaluate(() => syncOnce());
  const weights = page => page.evaluate(() => db.sets.map(s => s.w).sort((a, b) => a - b));

  test('a set logged on one phone reaches the other', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    await logSet(a.page, 225);
    expect(await sync(a.page)).not.toBeNull();

    const b = await device(browser, name, true);
    expect(await weights(b.page)).toEqual([225]);
    await a.close(); await b.close();
  });

  test('each keeps what the other did', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    const b = await device(browser, name, true);

    await logSet(a.page, 315);
    await logSet(b.page, 135);
    await sync(a.page);
    await sync(b.page);
    await sync(a.page);

    expect(await weights(a.page)).toEqual([135, 315]);
    expect(await weights(b.page)).toEqual([135, 315]);
    await a.close(); await b.close();
  });

  test('both editing the same record ends the same way on both', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    const b = await device(browser, name, true);

    // Offline on both, then reconciled. The later clock should win on each.
    await a.page.evaluate(() => { db.days[todayISO()] = { notes: 'from A' }; return save(); });
    await new Promise(r => setTimeout(r, 5));
    await b.page.evaluate(() => { db.days[todayISO()] = { notes: 'from B' }; return save(); });

    await sync(a.page); await sync(b.page); await sync(a.page); await sync(b.page);

    const notes = p => p.evaluate(() => db.days[todayISO()]?.notes);
    const onA = await notes(a.page), onB = await notes(b.page);
    expect(onA).toBe(onB);
    expect(['from A', 'from B']).toContain(onA);
    await a.close(); await b.close();
  });

  test('a delete travels, and does not come back on the next sync', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    const id = await logSet(a.page, 405);
    await sync(a.page);

    const b = await device(browser, name, true);
    expect(await weights(b.page)).toEqual([405]);

    await a.page.evaluate(i => {
      db.sets.splice(db.sets.findIndex(s => s.id === i), 1);
      return save();
    }, id);
    await sync(a.page);
    await sync(b.page);
    expect(await weights(b.page)).toEqual([]);

    // The resurrection this whole scheme exists to prevent: B still holds a
    // clock for the record, and must not push its old copy back.
    await sync(b.page); await sync(a.page);
    expect(await weights(a.page)).toEqual([]);
    expect(await weights(b.page)).toEqual([]);
    await a.close(); await b.close();
  });

  test('nothing logged while offline is lost', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    const b = await device(browser, name, true);

    for (const w of [100, 110, 120]) await logSet(a.page, w);
    for (const w of [200, 210]) await logSet(b.page, w);
    await sync(a.page); await sync(b.page); await sync(a.page); await sync(b.page);

    const want = [100, 110, 120, 200, 210];
    expect(await weights(a.page)).toEqual(want);
    expect(await weights(b.page)).toEqual(want);
    await a.close(); await b.close();
  });

  // The answer to a cursor older than the server's tombstones. Those deletes
  // are gone, so a plain merge would hand every one of them back. The reset
  // drops what the server does not have — and the whole question is how it
  // tells "deleted elsewhere, long ago" from "logged here, not sent yet".
  test('a reset drops what was deleted elsewhere and keeps what was never sent',
    async ({ browser }) => {
      const name = handle();
      const a = await device(browser, name);
      await logSet(a.page, 225);
      await sync(a.page);

      const r = await a.page.evaluate(async () => {
        // Synced once and now absent from the server: this is what a purged
        // delete looks like from here.
        db.sets.push({ id: 'purged', t: Date.now(), d: todayISO(), e: 'Deadlift',
                       dy: 'A', w: 999, r: 1, rir: 0, rest: null, u: 'lb' });
        await save();
        delete syncState.dirty['set:purged'];      // pretend it went up long ago

        // Logged on a plane and never sent. Absent from the server for an
        // entirely different reason, and dropping it would be losing a session.
        db.sets.push({ id: 'fresh', t: Date.now(), d: todayISO(), e: 'Deadlift',
                       dy: 'A', w: 111, r: 5, rir: 2, rest: null, u: 'lb' });
        await save();

        const dropped = await syncReset();
        return { dropped, ids: db.sets.map(s => s.id).sort(), dirty: Object.keys(syncState.dirty) };
      });

      expect(r.ids).not.toContain('purged');
      expect(r.ids).toContain('fresh');
      expect(r.dropped).toBeGreaterThan(0);

      // And the one it kept is on the server afterwards, not just locally.
      const b = await device(browser, name, true);
      expect(await weights(b.page)).toEqual([111, 225]);
      await a.close(); await b.close();
    });

  test('a cursor the server has outrun triggers the reset by itself', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    await logSet(a.page, 275);
    await sync(a.page);

    let served = 0;
    await a.page.route('**/v1/sync?since=*', route => {
      // One 409, then out of the way, so the reset it provokes can run for real.
      if (served++ > 0) return route.fallback();
      return route.fulfill({ status: 409, contentType: 'application/json',
                             body: JSON.stringify({ error: 'cursor_too_old', detail: '50' }) });
    });
    const out = await sync(a.page);
    await a.page.unroute('**/v1/sync?since=*');

    expect(out).not.toBeNull();
    expect(await weights(a.page)).toEqual([275]);
    await a.close();
  });

  test('a sync with no signal is not a failure', async ({ browser }) => {
    const name = handle();
    const a = await device(browser, name);
    await logSet(a.page, 500);
    // Pointed at a port with nothing behind it rather than intercepted: route
    // blocking does not reach requests the service worker makes on Playwright's
    // WebKit, and this has to be true on the engine the app is used on.
    await a.page.evaluate(() => { syncState.base = 'http://127.0.0.1:1'; });
    const out = await sync(a.page);
    expect(out).toBeNull();
    // The log is on the phone either way; the set is still there and still
    // waiting to go.
    expect(await weights(a.page)).toEqual([500]);
    expect(await a.page.evaluate(() => Object.keys(syncState.dirty).length)).toBeGreaterThan(0);
    expect(await a.page.evaluate(() => syncState.err)).toBeTruthy();

    await a.page.evaluate(() => { syncState.base = ''; });
    expect(await sync(a.page)).not.toBeNull();
    expect(await a.page.evaluate(() => Object.keys(syncState.dirty).length)).toBe(0);
    await a.close();
  });
});

// The screen that switches all of the above on. Driven through the real
// controls, against the real server, because "the engine works" and "a person
// can turn it on" are different claims.
test.describe('turning sync on', () => {
  test.describe.configure({ mode: 'serial' });
  const handle = () => 'u' + Math.random().toString(36).slice(2, 10);

  // An exception thrown inside a click handler is logged and forgotten: the
  // sheet simply does not open, and every assertion after it fails somewhere
  // else entirely. Collected here so the failure names itself.
  const open = async (browser) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(SYNC_URL);
    await page.waitForSelector('.ex');
    await page.click('#gear');
    return { ctx, page, errs, quiet: () => expect(errs, 'page errors').toEqual([]) };
  };

  test('off is said plainly, and set-up is the only thing offered', async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await expect(page.locator('#syncstat')).toContainText('Off');
    await expect(page.locator('#syncsetup')).toBeVisible();
    await expect(page.locator('#syncnow')).toBeHidden();
    await expect(page.locator('#syncoff')).toBeHidden();
    await ctx.close();
  });

  test('a passphrase is generated, and cannot be skipped past', async ({ browser }) => {
    const { ctx, page, quiet } = await open(browser);
    await page.click('#syncsetup');
    const phrase = await page.locator('#syncphrase').textContent();
    // Read off a screen and typed into another phone: no character that can be
    // mistaken for another, and enough of them to survive an offline grind.
    expect(phrase).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){4}$/);
    expect(phrase).not.toMatch(/[OI10]/);
    quiet();

    await page.fill('#synchandle', handle());
    await page.click('#syncgo');
    // There is no reset, so "I'll write it down later" is a decision to lose
    // the server copy. The app refuses to take it for them.
    await expect(page.locator('#syncerr')).toContainText('Write the passphrase down');
    // Refused, not merely complained about: the sheet is still open and nothing
    // was sent anywhere.
    await expect(page.locator('#syncsheet')).toHaveClass(/open/);
    expect(await page.evaluate(() => syncOn())).toBe(false);
    await expect(page.locator('#syncstat')).toContainText('Off');

    await page.click('#syncreroll');
    expect(await page.locator('#syncphrase').textContent()).not.toBe(phrase);
    // A new one is a new thing to write down.
    await expect(page.locator('#syncwrote')).not.toBeChecked();
    await ctx.close();
  });

  test('a bad name is refused before anything is sent', async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.click('#syncsetup');
    await page.check('#syncwrote');
    for (const bad of ['', 'A', 'has space', 'x']) {
      await page.fill('#synchandle', bad);
      await page.click('#syncgo');
      await expect(page.locator('#syncerr')).toContainText('2 to 32 characters');
    }
    await ctx.close();
  });

  test('a vault is created from the screen, and the status says so', async ({ browser }) => {
    const name = handle();
    const { ctx, page } = await open(browser);
    await page.evaluate(() => {
      db.sets.push({ id: 'ui-1', t: Date.now(), d: todayISO(), e: 'Deadlift', dy: 'A',
                     w: 245, r: 5, rir: 2, rest: null, u: 'lb' });
      return save();
    });
    await page.click('#syncsetup');
    const phrase = await page.locator('#syncphrase').textContent();
    await page.fill('#synchandle', name);
    await page.check('#syncwrote');
    await page.click('#syncgo');

    await expect(page.locator('#syncsheet')).not.toHaveClass(/open/);
    await expect(page.locator('#syncstat')).toContainText(`On as “${name}”`);
    await expect(page.locator('#syncnow')).toBeVisible();
    await expect(page.locator('#syncsetup')).toBeHidden();

    // And a second device joins with the name and the passphrase alone.
    const two = await open(browser);
    await two.page.click('#syncsetup');
    await two.page.click('[data-mode="join"]');
    await expect(two.page.locator('#syncphrase')).toBeHidden();
    await two.page.fill('#synchandle', name);
    await two.page.fill('#syncpass', phrase);
    await two.page.click('#syncgo');
    await expect(two.page.locator('#syncstat')).toContainText('On as');
    expect(await two.page.evaluate(() => db.sets.map(s => s.w))).toEqual([245]);

    await ctx.close(); await two.ctx.close();
  });

  test('the wrong passphrase is told apart from a name that is not there',
    async ({ browser }) => {
      const name = handle();
      const a = await open(browser);
      await a.page.click('#syncsetup');
      await a.page.fill('#synchandle', name);
      await a.page.check('#syncwrote');
      await a.page.click('#syncgo');
      await expect(a.page.locator('#syncstat')).toContainText('On as');

      const b = await open(browser);
      await b.page.click('#syncsetup');
      await b.page.click('[data-mode="join"]');
      await b.page.fill('#synchandle', name);
      await b.page.fill('#syncpass', 'WRNG-WRNG-WRNG-WRNG-WRNG');
      await b.page.click('#syncgo');
      await expect(b.page.locator('#syncerr')).toContainText('does not open it');

      await b.page.fill('#synchandle', handle());
      await b.page.click('#syncgo');
      await expect(b.page.locator('#syncerr')).toContainText('No log by that name');
      await a.ctx.close(); await b.ctx.close();
    });

  test('a taken name says what to do about it', async ({ browser }) => {
    const name = handle();
    const a = await open(browser);
    await a.page.click('#syncsetup');
    await a.page.fill('#synchandle', name);
    await a.page.check('#syncwrote');
    await a.page.click('#syncgo');
    await expect(a.page.locator('#syncstat')).toContainText('On as');

    const b = await open(browser);
    await b.page.click('#syncsetup');
    await b.page.fill('#synchandle', name);
    await b.page.check('#syncwrote');
    await b.page.click('#syncgo');
    await expect(b.page.locator('#syncerr')).toContainText('add this device to it instead');
    await a.ctx.close(); await b.ctx.close();
  });

  test('stopping leaves the log alone', async ({ browser }) => {
    const name = handle();
    const { ctx, page } = await open(browser);
    await page.evaluate(() => {
      db.sets.push({ id: 'keep-me', t: Date.now(), d: todayISO(), e: 'Deadlift', dy: 'A',
                     w: 185, r: 5, rir: 2, rest: null, u: 'lb' });
      return save();
    });
    await page.click('#syncsetup');
    await page.fill('#synchandle', name);
    await page.check('#syncwrote');
    await page.click('#syncgo');
    await expect(page.locator('#syncstat')).toContainText('On as');

    page.on('dialog', d => d.accept());
    await page.click('#syncoff');
    await expect(page.locator('#syncstat')).toContainText('Off');
    await expect(page.locator('#syncsetup')).toBeVisible();
    // Nothing is deleted by turning it off — not here, and not on the server.
    expect(await page.evaluate(() => db.sets.map(s => s.id))).toContain('keep-me');
    expect(await page.evaluate(() => localStorage.getItem('logbook-sync'))).not.toContain('keep-me');
    await ctx.close();
  });

  test('a set logged on one phone reaches the other without being asked',
    async ({ browser }) => {
      const name = handle();
      const a = await open(browser);
      await a.page.click('#syncsetup');
      const phrase = await a.page.locator('#syncphrase').textContent();
      await a.page.fill('#synchandle', name);
      await a.page.check('#syncwrote');
      await a.page.click('#syncgo');

      const b = await open(browser);
      await b.page.click('#syncsetup');
      await b.page.click('[data-mode="join"]');
      await b.page.fill('#synchandle', name);
      await b.page.fill('#syncpass', phrase);
      await b.page.click('#syncgo');
      await expect(b.page.locator('#syncstat')).toContainText('On as');
      await b.page.click('#setdone');

      // Logged on A the ordinary way, with nobody tapping "sync now" anywhere.
      await a.page.click('#setdone');
      await a.page.click('.ex[data-ex="Deadlift"]');
      await a.page.fill('#wt', '335');
      await a.page.fill('#reps', '3');
      await a.page.click('#logset');

      await expect.poll(
        () => b.page.evaluate(() => syncOnce().then(() => db.sets.map(s => s.w))),
        { timeout: 20000, intervals: [500, 1000, 2000] }
      ).toEqual([335]);
      await a.ctx.close(); await b.ctx.close();
    });
});
