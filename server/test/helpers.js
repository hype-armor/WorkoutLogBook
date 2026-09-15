import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configure } from '../src/index.js';

/** A server on an ephemeral port with a database of its own. */
export async function start(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'logbook-'));
  const base = configure({});
  const config = {
    ...base, dbPath: join(dir, 'test.db'), port: 0, host: '127.0.0.1', staticRoot: null,
    // Generous unless a test is about the limits, which sets its own.
    limits: { unlock: { capacity: 1e6, perSecond: 1e6 },
              create: { capacity: 1e6, perSecond: 1e6 },
              write: { capacity: 1e6, perSecond: 1e6 } },
    ...over
  };
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(origin + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };

  return {
    base: origin, db: app.db, config,
    get: (p, o) => call('GET', p, o),
    post: (p, body, o) => call('POST', p, { body, ...o }),
    del: (p, o) => call('DELETE', p, o),
    async stop() {
      await new Promise(r => app.server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Stand-ins for what the client's vault module produces: opaque to the server,
 * and random, because several tests turn on two of them differing. A
 * deterministic version of this hid a real hole — the test that checks a device
 * cannot be minted with the wrong secret was passing the right one.
 */
import { randomBytes } from 'node:crypto';
export const opaque = (n = 40) => randomBytes(n).toString('base64url');
export const passphraseFactor = (over = {}) => ({
  kind: 'passphrase', kdf: 'pbkdf2-sha256', iter: 600000,
  salt: opaque(16), mk: opaque(44), ...over
});

/** Create a vault and a device on it, the way a first launch would. */
export async function newVault(s, { handle = 'gam', authSecret = opaque(32), invite } = {}) {
  const made = await s.post('/v1/vaults', { handle, authSecret, factor: passphraseFactor(), invite });
  if (made.status !== 201) throw new Error('vault create failed: ' + made.text);
  const dev = await s.post('/v1/devices', { vaultId: made.body.vaultId, authSecret, label: 'phone' });
  if (dev.status !== 201) throw new Error('device create failed: ' + dev.text);
  return { vaultId: made.body.vaultId, authSecret, token: dev.body.token, deviceId: dev.body.deviceId };
}

/** Clocks sort as strings; these are in order. */
export const hlc = (ms, counter = 0, device = 'aaaaaaaa') =>
  ms.toString(36).padStart(10, '0') + ':' + counter.toString(36).padStart(4, '0') + ':' + device;

export async function mintInvite(s, uses = 1) {
  const { rid, sha256, inviteCode, normaliseCode } = await import('../src/ids.js');
  const code = inviteCode();
  s.db.prepare(`INSERT INTO invites (id, code_hash, uses_left, expires_at, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
    .run(rid(), sha256(normaliseCode(code)), uses, null, null, Date.now());
  return code;
}
