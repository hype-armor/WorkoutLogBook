import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, newVault, opaque, hlc } from './helpers.js';

const rec = (recId, at, over = {}) =>
  ({ recId, hlc: hlc(at), ciphertext: opaque(32), ...over });

describe('sync', () => {
  let s;
  before(async () => { s = await start({ openRegistration: true }); });
  after(async () => { await s.stop(); });

  const vault = (handle) => newVault(s, { handle });

  test('what is pushed comes back, and the cursor moves with it', async () => {
    const v = await vault('sync1');
    const empty = await s.get('/v1/sync?since=0', { token: v.token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.records, []);
    assert.equal(empty.body.latest, 0);

    const push = await s.post('/v1/sync',
      { records: [rec('a', 100), rec('b', 101)] }, { token: v.token });
    assert.equal(push.status, 200);
    assert.deepEqual(push.body.accepted.sort(), ['a', 'b']);
    assert.deepEqual(push.body.superseded, []);

    const pull = await s.get('/v1/sync?since=0', { token: v.token });
    assert.equal(pull.body.records.length, 2);
    assert.equal(pull.body.latest, 2);
    // Strictly increasing, so a cursor can never skip a record.
    assert.deepEqual(pull.body.records.map(r => r.seq), [1, 2]);
    // Nothing since the cursor is an empty answer, not the whole vault again.
    const after = await s.get(`/v1/sync?since=${pull.body.latest}`, { token: v.token });
    assert.deepEqual(after.body.records, []);
  });

  test('the newer clock wins, whichever order it arrives in', async () => {
    const v = await vault('sync2');
    const old = rec('x', 100), fresh = rec('x', 200);

    await s.post('/v1/sync', { records: [fresh] }, { token: v.token });
    const late = await s.post('/v1/sync', { records: [old] }, { token: v.token });
    // A write that lost is reported rather than dropped in silence: the client
    // has an older version and needs to pull before it pushes again.
    assert.deepEqual(late.body.superseded, ['x']);
    assert.deepEqual(late.body.accepted, []);

    const pull = await s.get('/v1/sync?since=0', { token: v.token });
    assert.equal(pull.body.records.length, 1);
    assert.equal(pull.body.records[0].ciphertext, fresh.ciphertext);
  });

  test('an equal clock is not newer', async () => {
    const v = await vault('sync3');
    const one = rec('x', 100);
    await s.post('/v1/sync', { records: [one] }, { token: v.token });
    const same = await s.post('/v1/sync',
      { records: [{ ...one, ciphertext: opaque(32) }] }, { token: v.token });
    // Two devices writing the same record at the same instant is what the
    // device id in the clock is for; without a decision here the last request
    // to arrive would win, which is not an ordering at all.
    assert.deepEqual(same.body.superseded, ['x']);
  });

  test('two devices converge on the same records', async () => {
    const v = await vault('sync4');
    const second = await s.post('/v1/devices', { vaultId: v.vaultId, authSecret: v.authSecret });
    const tablet = second.body.token;

    await s.post('/v1/sync', { records: [rec('phone-set', 100)] }, { token: v.token });
    const seen = await s.get('/v1/sync?since=0', { token: tablet });
    assert.deepEqual(seen.body.records.map(r => r.recId), ['phone-set']);

    await s.post('/v1/sync', { records: [rec('tablet-set', 101)] }, { token: tablet });
    const back = await s.get(`/v1/sync?since=${seen.body.latest}`, { token: v.token });
    assert.deepEqual(back.body.records.map(r => r.recId), ['tablet-set']);
  });

  test('a delete travels as a record, and carries no ciphertext', async () => {
    const v = await vault('sync5');
    await s.post('/v1/sync', { records: [rec('gone', 100)] }, { token: v.token });
    await s.post('/v1/sync',
      { records: [{ recId: 'gone', hlc: hlc(200), deleted: true }] }, { token: v.token });

    const pull = await s.get('/v1/sync?since=0', { token: v.token });
    const row = pull.body.records.find(r => r.recId === 'gone');
    assert.equal(row.deleted, true);
    // The contents go when the record does: a tombstone that still carries the
    // set is a delete that kept a copy.
    assert.equal(row.ciphertext, null);
  });

  test('a vault cannot see another vault\'s records', async () => {
    const mine = await vault('sync6');
    const theirs = await vault('sync7');
    await s.post('/v1/sync', { records: [rec('secret', 100)] }, { token: mine.token });
    const pull = await s.get('/v1/sync?since=0', { token: theirs.token });
    assert.deepEqual(pull.body.records, []);

    // And the same address in two vaults is two different records.
    await s.post('/v1/sync', { records: [rec('secret', 50)] }, { token: theirs.token });
    const a = await s.get('/v1/sync?since=0', { token: mine.token });
    const b = await s.get('/v1/sync?since=0', { token: theirs.token });
    assert.notEqual(a.body.records[0].ciphertext, b.body.records[0].ciphertext);
  });

  test('a page ends where the next one starts', async () => {
    const v = await vault('sync8');
    const many = Array.from({ length: 25 }, (_, i) => rec('r' + i, 100 + i));
    await s.post('/v1/sync', { records: many }, { token: v.token });

    const seen = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const page = await s.get(`/v1/sync?since=${cursor}&limit=10`, { token: v.token });
      if (!page.body.records.length) break;
      seen.push(...page.body.records.map(r => r.recId));
      cursor = page.body.next;
    }
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25, 'no record appears on two pages');
  });

  test('a cursor from before a purge is refused rather than answered wrongly', async () => {
    const v = await vault('sync9');
    await s.post('/v1/sync', { records: [rec('a', 100)] }, { token: v.token });
    s.db.prepare('UPDATE vaults SET purged_below = 50 WHERE id = ?').run(v.vaultId);
    const stale = await s.get('/v1/sync?since=10', { token: v.token });
    // Answering it would leave the client holding deletes it never saw, and it
    // would put every one of them back.
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'cursor_too_old');
    assert.equal((await s.get('/v1/sync?since=0', { token: v.token })).status, 200);
  });

  test('sync needs a token', async () => {
    assert.equal((await s.get('/v1/sync?since=0')).status, 401);
    assert.equal((await s.post('/v1/sync', { records: [] })).status, 401);
  });

  test('malformed pushes are refused whole', async () => {
    const v = await vault('sync10');
    const bad = [
      { records: 'nope' },
      { records: [{ hlc: hlc(1) }] },                    // no address
      { records: [{ recId: 'a' }] },                     // no clock
      { records: [{ recId: 'a', hlc: 'x'.repeat(100) }] }
    ];
    for (const body of bad) {
      assert.equal((await s.post('/v1/sync', body, { token: v.token })).status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await s.get('/v1/sync?since=0', { token: v.token })).body.records, []);
  });

  test('a record larger than the cap is refused, and takes nothing with it', async () => {
    const s2 = await start({ openRegistration: true, maxRecordBytes: 128 });
    const v = await newVault(s2, { handle: 'capped' });
    const r = await s2.post('/v1/sync',
      { records: [rec('small', 100, { ciphertext: 'x'.repeat(64) }),
                  rec('huge', 101, { ciphertext: 'x'.repeat(256) })] }, { token: v.token });
    assert.equal(r.status, 413);
    // Checked before anything is written, so a bad record in a batch does not
    // leave half of it applied.
    assert.deepEqual((await s2.get('/v1/sync?since=0', { token: v.token })).body.records, []);
    await s2.stop();
  });

  test('a full vault stops taking writes', async () => {
    const s2 = await start({ openRegistration: true, maxVaultBytes: 512 });
    const v = await newVault(s2, { handle: 'full' });
    const ok = await s2.post('/v1/sync',
      { records: [rec('a', 100, { ciphertext: 'x'.repeat(400) })] }, { token: v.token });
    assert.equal(ok.status, 200);
    const over = await s2.post('/v1/sync',
      { records: [rec('b', 101, { ciphertext: 'x'.repeat(400) })] }, { token: v.token });
    assert.equal(over.status, 413);
    assert.equal(over.body.error, 'vault_full');
    await s2.stop();
  });
});

describe('rate limits', () => {
  test('the unlock door closes after a few tries', async () => {
    const s = await start({
      openRegistration: true,
      limits: { unlock: { capacity: 2, perSecond: 0 },
                create: { capacity: 100, perSecond: 100 },
                write: { capacity: 100, perSecond: 100 } }
    });
    const v = await newVault(s, { handle: 'slow' });
    // newVault spent one on the device mint, so one is left.
    assert.equal((await s.post('/v1/auth/passphrase', { handle: 'slow' })).status, 200);
    const stopped = await s.post('/v1/auth/passphrase', { handle: 'slow' });
    assert.equal(stopped.status, 429);
    assert.equal(stopped.body.error, 'slow_down');
    // The limit is on the door, not on the answer: a valid token still works.
    assert.equal((await s.get('/v1/keys', { token: v.token })).status, 200);
    await s.stop();
  });

  test('a forwarded-for header is ignored unless the deployment says otherwise', async () => {
    const s = await start({
      openRegistration: true,
      limits: { unlock: { capacity: 1, perSecond: 0 },
                create: { capacity: 100, perSecond: 100 },
                write: { capacity: 100, perSecond: 100 } }
    });
    await s.post('/v1/auth/passphrase', { handle: 'nobody' });
    // Inventing an address must not hand the caller a fresh limit.
    const spoofed = await s.post('/v1/auth/passphrase', { handle: 'nobody' },
      { headers: { 'X-Forwarded-For': '10.1.2.3' } });
    assert.equal(spoofed.status, 429);
    await s.stop();
  });
});
