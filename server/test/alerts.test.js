import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, newVault, opaque } from './helpers.js';
import { hostAllowed } from '../src/hosts.js';
import { scheduler } from '../src/scheduler.js';
import { newVapidKeys } from '../src/push.js';

const subscription = (over = {}) => ({
  endpoint: 'https://web.push.apple.com/' + opaque(16),
  keys: { p256dh: opaque(65), auth: opaque(16) },
  ...over
});

describe('which hosts this server will talk to', () => {
  test('the push services, and nothing else', () => {
    for (const ok of ['https://web.push.apple.com/x',
                      'https://fcm.googleapis.com/fcm/send/abc',
                      'https://updates.push.services.mozilla.com/wpush/v2/abc',
                      'https://autopush.push.services.mozilla.com/x']) {
      assert.equal(hostAllowed(ok), true, ok);
    }
  });

  test('the way in to the network this server runs on is closed', () => {
    // Unvalidated, POST /v1/push/subscribe is a request this server will make
    // to anywhere — a metadata endpoint, a printer, another container.
    for (const no of ['http://169.254.169.254/latest/meta-data/',
                      'https://169.254.169.254/',
                      'http://localhost:8080/v1/sync',
                      'https://10.0.0.5/admin',
                      'file:///etc/passwd',
                      'https://user:pass@web.push.apple.com/x',
                      // Plaintext would put the payload and a token on the wire.
                      'http://web.push.apple.com/x']) {
      assert.equal(hostAllowed(no), false, no);
    }
  });

  test('a wildcard matches a subdomain, not a suffix of a name', () => {
    assert.equal(hostAllowed('https://a.push.services.mozilla.com/x'), true);
    // Ends with the right letters, is not the right host.
    assert.equal(hostAllowed('https://evilpush.services.mozilla.com/x'), false);
    assert.equal(hostAllowed('https://push.services.mozilla.com.evil.test/x'), false);
    assert.equal(hostAllowed('https://notify.windows.com.attacker.test/x'), false);
  });

  test('garbage is not a host', () => {
    for (const no of ['', 'not a url', '//x', null, undefined, 'https://']) {
      assert.equal(hostAllowed(no), false, String(no));
    }
  });
});

describe('subscriptions and alerts', () => {
  let s, v;
  before(async () => {
    s = await start({ openRegistration: true, pushHosts: ['web.push.apple.com', 'push.test'] });
    v = await newVault(s, { handle: 'pusher' });
  });
  after(async () => { await s.stop(); });

  test('a device subscribes once, and re-subscribing replaces it', async () => {
    const a = await s.post('/v1/push/subscribe', subscription(), { token: v.token });
    assert.equal(a.status, 201);
    const b = await s.post('/v1/push/subscribe', subscription(), { token: v.token });
    assert.equal(b.status, 201);
    // A browser that re-subscribes must not leave the old endpoint collecting
    // alerts nobody will read.
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 1);
  });

  test('an endpoint pointing anywhere else is refused', async () => {
    const r = await s.post('/v1/push/subscribe',
      subscription({ endpoint: 'http://169.254.169.254/latest/' }), { token: v.token });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'endpoint_not_allowed');
  });

  test('an alert is scheduled, moved and cancelled', async () => {
    await s.post('/v1/push/subscribe', subscription(), { token: v.token });
    const made = await s.post('/v1/alerts',
      { fireAt: Date.now() + 180000, payload: opaque(40) }, { token: v.token });
    assert.equal(made.status, 201);

    // Adding time to a rest timer moves the alert rather than making a second.
    const moved = await s.post('/v1/alerts/' + made.body.alertId,
      { fireAt: Date.now() + 240000 }, { token: v.token });
    assert.equal(moved.status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);

    const off = await s.del('/v1/alerts/' + made.body.alertId, { token: v.token });
    assert.equal(off.status, 200);
    assert.equal(s.db.prepare('SELECT state FROM alerts').get().state, 'cancelled');
  });

  test('an alert cannot be scheduled without somewhere to send it', async () => {
    const other = await newVault(s, { handle: 'nosub' });
    const r = await s.post('/v1/alerts',
      { fireAt: Date.now() + 1000, payload: opaque(8) }, { token: other.token });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_subscribed');
  });

  test('a year from now is not a rest timer', async () => {
    await s.post('/v1/push/subscribe', subscription(), { token: v.token });
    const r = await s.post('/v1/alerts',
      { fireAt: Date.now() + 400 * 86400000, payload: opaque(8) }, { token: v.token });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'too_far_ahead');
  });

  test('a device cannot touch another device\'s alerts', async () => {
    await s.post('/v1/push/subscribe', subscription(), { token: v.token });
    const mine = await s.post('/v1/alerts',
      { fireAt: Date.now() + 60000, payload: opaque(8) }, { token: v.token });
    const them = await newVault(s, { handle: 'stranger' });
    await s.post('/v1/push/subscribe', subscription(), { token: them.token });
    assert.equal((await s.del('/v1/alerts/' + mine.body.alertId, { token: them.token })).status, 404);
    assert.equal((await s.post('/v1/alerts/' + mine.body.alertId,
      { fireAt: Date.now() + 1000 }, { token: them.token })).status, 404);
  });

  test('a flood of pending alerts is capped', async () => {
    const s2 = await start({ openRegistration: true, maxPending: 2,
                             pushHosts: ['web.push.apple.com'] });
    const v2 = await newVault(s2, { handle: 'capped' });
    await s2.post('/v1/push/subscribe', subscription(), { token: v2.token });
    for (let i = 0; i < 2; i++) {
      assert.equal((await s2.post('/v1/alerts',
        { fireAt: Date.now() + 60000 + i, payload: opaque(8) }, { token: v2.token })).status, 201);
    }
    const over = await s2.post('/v1/alerts',
      { fireAt: Date.now() + 99000, payload: opaque(8) }, { token: v2.token });
    assert.equal(over.status, 429);
    await s2.stop();
  });

  test('revoking a device takes its subscription with it', async () => {
    const extra = await s.post('/v1/devices',
      { vaultId: v.vaultId, authSecret: v.authSecret }, {});
    await s.post('/v1/push/subscribe', subscription(), { token: extra.body.token });
    const before = s.db.prepare('SELECT COUNT(*) n FROM push_subs').get().n;
    await s.del('/v1/devices/' + extra.body.deviceId, { token: v.token });
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, before - 1);
  });
});

describe('the scheduler', () => {
  let s, v;
  const vapid = { ...newVapidKeys(), subject: 'mailto:x@example.invalid' };

  before(async () => {
    s = await start({ openRegistration: true, pushHosts: ['web.push.apple.com'],
                      vapidPublic: vapid.publicKey, vapidPrivate: vapid.privateKey,
                      vapidSubject: vapid.subject });
    v = await newVault(s, { handle: 'ticker' });
    await s.post('/v1/push/subscribe', subscription(), { token: v.token });
  });
  after(async () => { await s.stop(); });

  const clockWith = sent => scheduler({
    db: s.db, config: s.config,
    send: async (sub, payload) => { sent.push({ to: sub.endpoint, payload: payload.toString() }); return { ok: true }; }
  });

  test('nothing is sent before it is due', async () => {
    const at = Date.now() + 60000;
    await s.post('/v1/alerts', { fireAt: at, payload: 'later' }, { token: v.token });
    const sent = [];
    await clockWith(sent).tick(Date.now());
    assert.deepEqual(sent, []);
    // and then it is
    await clockWith(sent).tick(at + 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload, 'later');
  });

  test('two ticks at once cannot send the same alert twice', async () => {
    await s.post('/v1/alerts', { fireAt: Date.now() - 1, payload: 'once' }, { token: v.token });
    const sent = [];
    // Claimed in one statement before anything is sent, so overlapping ticks —
    // or a second scheduler that should not be running — cannot both take it.
    await Promise.all([clockWith(sent).tick(), clockWith(sent).tick(), clockWith(sent).tick()]);
    assert.equal(sent.filter(x => x.payload === 'once').length, 1);
  });

  test('a cancelled alert is not sent', async () => {
    const made = await s.post('/v1/alerts',
      { fireAt: Date.now() + 5000, payload: 'cancelled' }, { token: v.token });
    await s.del('/v1/alerts/' + made.body.alertId, { token: v.token });
    const sent = [];
    await clockWith(sent).tick(Date.now() + 10000);
    assert.equal(sent.filter(x => x.payload === 'cancelled').length, 0);
  });

  test('a subscription the browser says is finished is removed', async () => {
    await s.post('/v1/alerts', { fireAt: Date.now() - 1, payload: 'gone' }, { token: v.token });
    const clock = scheduler({ db: s.db, config: s.config,
      send: async () => ({ ok: false, gone: true, status: 410 }) });
    await clock.tick();
    // How the server learns someone deleted the app.
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 0);
  });

  test('a restart in the middle of a rest loses nothing', async () => {
    await s.post('/v1/push/subscribe', subscription(), { token: v.token });
    const at = Date.now() + 3000;
    await s.post('/v1/alerts', { fireAt: at, payload: 'survives' }, { token: v.token });
    // Nothing is held in memory: a scheduler built fresh, as one would be after
    // a deploy, finds the row and sends it.
    const sent = [];
    await clockWith(sent).tick(at + 1);
    assert.equal(sent.filter(x => x.payload === 'survives').length, 1);
  });

  test('delivered alerts do not pile up', async () => {
    const clock = clockWith([]);
    s.db.prepare(`INSERT INTO alerts (id, sub_id, fire_at, payload, state, created_at)
                  SELECT 'old', id, 0, 'x', 'sent', 0 FROM push_subs LIMIT 1`).run();
    clock.sweep(Date.now());
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM alerts WHERE id = 'old'").get().n, 0);
  });
});
