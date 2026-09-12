import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { start, newVault } from './helpers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the http surface', () => {
  let s;
  before(async () => { s = await start({ openRegistration: true }); });
  after(async () => { await s.stop(); });

  test('health and readiness answer without a token', async () => {
    assert.equal((await s.get('/healthz')).status, 200);
    const ready = await s.get('/readyz');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ok, true);
  });

  test('config says what a client needs before it has an account', async () => {
    const r = await s.get('/v1/config');
    assert.equal(r.status, 200);
    assert.equal(r.body.kdf, 'pbkdf2-sha256');
    assert.equal(r.body.iterations, 600000);
    assert.equal(r.body.openRegistration, true);
    // Present from the start so a client built against it need not guess
    // whether the field will appear once notifications land.
    assert.equal(r.body.vapidPublicKey, null);
  });

  test('an unknown api path is a 404, never a file', async () => {
    const r = await s.get('/v1/nonsense');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'no_such_route');
  });

  test('a body that is not json is refused as such', async () => {
    const res = await fetch(s.base + '/v1/auth/passphrase', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json'
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_json');
  });

  test('an oversized body is refused before it is read', async () => {
    const v = await newVault(s, { handle: 'big' });
    const res = await fetch(s.base + '/v1/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.token },
      body: JSON.stringify({ records: [], pad: 'x'.repeat(10 * 1024 * 1024) })
    });
    assert.equal(res.status, 413);
  });

  test('a wrong method on a real path is not a match', async () => {
    assert.equal((await s.del('/v1/config')).status, 404);
  });
});

describe('serving the app from the same origin', () => {
  let s;
  before(async () => { s = await start({ openRegistration: true, staticRoot: repoRoot }); });
  after(async () => { await s.stop(); });

  test('the app is served at the root', async () => {
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>/i);
  });

  test('the worker and the manifest are served with the right types', async () => {
    const sw = await fetch(s.base + '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    const mf = await fetch(s.base + '/manifest.webmanifest');
    assert.match(mf.headers.get('content-type'), /manifest\+json/);
  });

  test('the api still wins over a file of the same name', async () => {
    const r = await s.get('/v1/config');
    assert.equal(r.status, 200);
    assert.equal(r.body.kdf, 'pbkdf2-sha256');
  });

  test('only the app is served, not the directory it sits in', async () => {
    // The static root is a git checkout. Serving whatever it finds there hands
    // out the tests, the server's own source, `.git` — and, if LOGBOOK_DB is a
    // relative path, the vault database, which is the one file the encryption
    // exists so that losing would not matter.
    const off = ['/package.json', '/../package.json', '/..%2fpackage.json',
                 '/%2e%2e/%2e%2e/etc/passwd', '/img/../../etc/passwd', '/./../../etc/hosts',
                 '/.git/config', '/server/src/routes.js', '/tests/helpers.js',
                 '/playwright.config.js', '/logbook.db', '/CHANGELOG.md'];
    for (const path of off) {
      const res = await fetch(s.base + path, { redirect: 'manual' });
      assert.ok(res.status === 403 || res.status === 404, `${path} answered ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('root:'), `${path} served /etc/passwd`);
      assert.ok(!body.includes('devDependencies'), `${path} served package.json`);
      assert.ok(!body.includes('vault_keys'), `${path} served server source`);
    }
  });

  test('the app\'s own files are all reachable', async () => {
    for (const path of ['/', '/index.html', '/sw.js', '/manifest.webmanifest',
                        '/icon-192.png', '/apple-touch-icon.png', '/favicon-32.png',
                        '/img/barbell-curl-0.webp']) {
      const res = await fetch(s.base + path);
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
    }
  });

  test('a missing file is a 404 rather than the app', async () => {
    const res = await fetch(s.base + '/no-such-file.png');
    assert.equal(res.status, 404);
  });
});
