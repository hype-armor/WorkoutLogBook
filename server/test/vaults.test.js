import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, newVault, opaque, passphraseFactor, mintInvite } from './helpers.js';

describe('creating and opening a vault', () => {
  let s;
  before(async () => { s = await start({ openRegistration: true }); });
  after(async () => { await s.stop(); });

  test('a vault is created and a device can speak for it', async () => {
    const v = await newVault(s, { handle: 'alice' });
    assert.match(v.vaultId, /^[\w-]{20,}$/);
    assert.ok(v.token.includes('.'), 'the token carries its own device id');
    const keys = await s.get('/v1/keys', { token: v.token });
    assert.equal(keys.status, 200);
    assert.equal(keys.body.keys.length, 1);
    assert.equal(keys.body.keys[0].kind, 'passphrase');
    // The wrapped key is never listed back out of a route that does not need it.
    assert.ok(!JSON.stringify(keys.body).includes('mk'));
  });

  test('a handle can only be taken once', async () => {
    await newVault(s, { handle: 'bob' });
    const again = await s.post('/v1/vaults',
      { handle: 'bob', authSecret: opaque(32), factor: passphraseFactor() });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'handle_taken');
  });

  test('a vault cannot be created with only a passkey', async () => {
    // One lost phone from unopenable, and nobody who could reset it.
    const r = await s.post('/v1/vaults', {
      handle: 'carol', authSecret: opaque(32),
      factor: { kind: 'passkey', credentialId: opaque(16), mk: opaque(44) }
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'passphrase_required');
  });

  test('a bad handle is refused', async () => {
    for (const handle of ['', 'A', 'has space', 'x'.repeat(64), '-leading']) {
      const r = await s.post('/v1/vaults',
        { handle, authSecret: opaque(32), factor: passphraseFactor() });
      assert.equal(r.status, 400, `handle ${JSON.stringify(handle)}`);
    }
  });

  test('the wrapped key comes back for a handle, and nothing else does', async () => {
    const secret = opaque(32);
    await newVault(s, { handle: 'dave', authSecret: secret });
    const r = await s.post('/v1/auth/passphrase', { handle: 'dave' });
    assert.equal(r.status, 200);
    assert.equal(r.body.factor.kind, 'passphrase');
    assert.equal(r.body.factor.iter, 600000);
    assert.ok(r.body.factor.salt && r.body.factor.mk);
    // Useless without the passphrase — but the secret that proves a client
    // unlocked the vault must never be handed out with it.
    assert.ok(!r.text.includes(secret));
  });

  test('an unknown handle has nothing to hand back', async () => {
    const r = await s.post('/v1/auth/passphrase', { handle: 'nobody' });
    assert.equal(r.status, 404);
  });

  test('a device cannot be minted without proving the vault was unlocked', async () => {
    const v = await newVault(s, { handle: 'erin' });
    const r = await s.post('/v1/devices', { vaultId: v.vaultId, authSecret: opaque(32) });
    assert.equal(r.status, 401);
    // Naming a handle would otherwise be enough to mint a token that could not
    // read one record and could delete every one of them.
    const none = await s.post('/v1/devices', { vaultId: v.vaultId });
    assert.equal(none.status, 401);
  });

  test('a revoked device stops being able to speak', async () => {
    const v = await newVault(s, { handle: 'frank' });
    const second = await s.post('/v1/devices', { vaultId: v.vaultId, authSecret: v.authSecret });
    const gone = await s.del('/v1/devices/' + second.body.deviceId, { token: v.token });
    assert.equal(gone.status, 200);
    assert.equal((await s.get('/v1/keys', { token: second.body.token })).status, 401);
    assert.equal((await s.get('/v1/keys', { token: v.token })).status, 200);
  });

  test('one vault cannot revoke another vault\'s device', async () => {
    const mine = await newVault(s, { handle: 'grace' });
    const theirs = await newVault(s, { handle: 'heidi' });
    const r = await s.del('/v1/devices/' + theirs.deviceId, { token: mine.token });
    assert.equal(r.status, 404);
    assert.equal((await s.get('/v1/keys', { token: theirs.token })).status, 200);
  });

  test('a garbled token is refused without saying which half was wrong', async () => {
    const v = await newVault(s, { handle: 'ivan' });
    for (const token of ['', 'nonsense', v.deviceId, v.deviceId + '.wrong', '.' + v.token]) {
      const r = await s.get('/v1/keys', { token });
      assert.equal(r.status, 401, `token ${JSON.stringify(token)}`);
      assert.equal(r.body.error, 'unauthorized');
    }
  });
});

describe('factors', () => {
  let s;
  before(async () => { s = await start({ openRegistration: true }); });
  after(async () => { await s.stop(); });

  test('a passkey is enrolled beside the passphrase', async () => {
    const v = await newVault(s, { handle: 'judy' });
    const add = await s.post('/v1/keys',
      { factor: { kind: 'passkey', credentialId: 'cred-1', mk: opaque(44), label: 'iPhone' } },
      { token: v.token });
    assert.equal(add.status, 201);
    const keys = await s.get('/v1/keys', { token: v.token });
    assert.deepEqual(keys.body.keys.map(k => k.kind).sort(), ['passkey', 'passphrase']);
  });

  test('the same passkey cannot be enrolled twice', async () => {
    const v = await newVault(s, { handle: 'ken' });
    const factor = { kind: 'passkey', credentialId: 'cred-shared', mk: opaque(44) };
    assert.equal((await s.post('/v1/keys', { factor }, { token: v.token })).status, 201);
    const again = await s.post('/v1/keys', { factor }, { token: v.token });
    assert.equal(again.status, 409);
  });

  test('the last passphrase cannot be removed', async () => {
    const v = await newVault(s, { handle: 'lena' });
    const keys = await s.get('/v1/keys', { token: v.token });
    const r = await s.del('/v1/keys/' + keys.body.keys[0].id, { token: v.token });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'last_passphrase');
  });

  test('a passkey can be removed, and a second passphrase can too', async () => {
    const v = await newVault(s, { handle: 'mike' });
    const pk = await s.post('/v1/keys',
      { factor: { kind: 'passkey', credentialId: 'cred-2', mk: opaque(44) } }, { token: v.token });
    assert.equal((await s.del('/v1/keys/' + pk.body.keyId, { token: v.token })).status, 200);

    const extra = await s.post('/v1/keys', { factor: passphraseFactor() }, { token: v.token });
    assert.equal((await s.del('/v1/keys/' + extra.body.keyId, { token: v.token })).status, 200);
  });
});

describe('invites', () => {
  let s;
  before(async () => { s = await start({ openRegistration: false }); });
  after(async () => { await s.stop(); });

  test('a vault cannot be created without one', async () => {
    const r = await s.post('/v1/vaults',
      { handle: 'nina', authSecret: opaque(32), factor: passphraseFactor() });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'invite_required');
  });

  test('a code works once and then does not', async () => {
    const code = await mintInvite(s, 1);
    assert.equal((await s.post('/v1/vaults',
      { handle: 'olive', authSecret: opaque(32), factor: passphraseFactor(), invite: code })).status, 201);
    const second = await s.post('/v1/vaults',
      { handle: 'pete', authSecret: opaque(32), factor: passphraseFactor(), invite: code });
    assert.equal(second.status, 403);
  });

  test('a code is read back the way it is written down', async () => {
    const code = await mintInvite(s, 1);
    // Typed off a screen, so case and the dashes must not matter.
    const typed = code.toLowerCase().replace(/-/g, ' ');
    assert.equal((await s.post('/v1/vaults',
      { handle: 'quinn', authSecret: opaque(32), factor: passphraseFactor(), invite: typed })).status, 201);
  });

  test('the code itself is never stored', async () => {
    const code = await mintInvite(s, 1);
    const rows = s.db.prepare('SELECT * FROM invites').all();
    assert.ok(rows.length);
    assert.ok(!JSON.stringify(rows).includes(code.replace(/-/g, '')));
  });

  test('adding a device to an existing vault needs no invite', async () => {
    const code = await mintInvite(s, 1);
    const secret = opaque(32);
    const made = await s.post('/v1/vaults',
      { handle: 'rita', authSecret: secret, factor: passphraseFactor(), invite: code });
    // The code is spent, and a second device still joins: the gate here is the
    // passphrase, which is a stronger one than a code read off a screen.
    const second = await s.post('/v1/devices', { vaultId: made.body.vaultId, authSecret: secret });
    assert.equal(second.status, 201);
    assert.equal((await s.get('/v1/keys', { token: second.body.token })).status, 200);
  });
});
