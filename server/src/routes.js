// The API. Five things happen here: a vault is created behind an invite, a
// device proves it unlocked one, factors are enrolled and removed, and records
// are pulled and pushed.
//
// What the server does not do is read anything. Every `ciphertext` and
// `wrapped_mk` below is opaque to this file; the only plaintext it handles is
// the clock, and that is here precisely so it can keep the newer of two
// versions of something it cannot open.
import { fail, json, readJson, router } from './http.js';
import { rid, sha256, sameSecret, mintToken, splitToken, normaliseCode } from './ids.js';
import { tx } from './db.js';
import { limiter } from './limit.js';

const now = () => Date.now();
const HANDLE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const str = (v, max) => (typeof v === 'string' && v.length && v.length <= max ? v : null);

function factorRow(f) {
  if (!f || typeof f !== 'object') fail(400, 'bad_factor');
  const kind = f.kind === 'passkey' ? 'passkey' : f.kind === 'passphrase' ? 'passphrase' : null;
  if (!kind) fail(400, 'bad_factor', 'kind must be passphrase or passkey');
  const mk = str(f.mk, 4096);
  if (!mk) fail(400, 'bad_factor', 'missing wrapped key');
  if (kind === 'passphrase' && !str(f.salt, 256)) fail(400, 'bad_factor', 'missing salt');
  const credentialId = kind === 'passkey' ? str(f.credentialId, 512) : null;
  if (kind === 'passkey' && !credentialId) fail(400, 'bad_factor', 'missing credential id');
  const params = { kdf: f.kdf ?? null, iter: Number(f.iter) || null, salt: f.salt ?? null };
  return { kind, mk, credentialId, params: JSON.stringify(params), label: str(f.label, 64) };
}

export function routes(ctx) {
  const { db, config } = ctx;
  const r = router();

  // Per server, not per module: two of these in one process must not throttle
  // each other. The unlock door is the slowest in the building — it is the one
  // place an attacker can collect a wrapped key to grind against offline.
  const limits = {
    unlock: limiter(config.limits.unlock),
    create: limiter(config.limits.create),
    write: limiter(config.limits.write)
  };
  ctx.sweep = () => { for (const l of Object.values(limits)) l.sweep(); };

  // x-forwarded-for is a header, which means it is whatever the client says it
  // is. Trusting it unasked would let anyone reset their own rate limit by
  // inventing an address; ignoring it behind the reverse proxy that terminates
  // TLS would put every client in one bucket. So it is a deployment question,
  // and the deployment has to answer it.
  const ip = req => (config.trustProxy
    && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || req.socket.remoteAddress || 'unknown';
  const throttle = (bucket, key) => {
    const wait = bucket.take(key);
    if (wait) fail(429, 'slow_down', String(wait));
  };

  /** A device token, or nothing. Never says which half was wrong. */
  function device(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) fail(401, 'unauthorized');
    const parts = splitToken(header.slice(7));
    if (!parts) fail(401, 'unauthorized');
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(parts.deviceId);
    if (!row || !sameSecret(row.token_hash, sha256(parts.secret))) fail(401, 'unauthorized');
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
    return row;
  }

  /* ---------- what this instance is ---------- */

  r.get('/v1/config', async (req, res) => json(res, 200, {
    kdf: 'pbkdf2-sha256',
    iterations: config.kdfIterations,
    openRegistration: config.openRegistration,
    // Filled in when notifications land; present from the start so a client
    // built against it does not have to guess whether the field will appear.
    vapidPublicKey: config.vapidPublic || null
  }));

  /* ---------- creating a vault ---------- */

  r.post('/v1/vaults', async (req, res) => {
    throttle(limits.create, ip(req));
    const body = await readJson(req, 16 * 1024);
    const handle = str(body.handle, 32)?.toLowerCase();
    if (!handle || !HANDLE.test(handle)) fail(400, 'bad_handle');
    const authSecret = str(body.authSecret, 512);
    if (!authSecret) fail(400, 'bad_auth');
    const factor = factorRow(body.factor);
    if (factor.kind !== 'passphrase') {
      // A vault whose only factor is a passkey is one lost phone away from
      // being unopenable, and there is nobody who could reset it.
      fail(400, 'passphrase_required', 'the first factor must be a passphrase');
    }

    let invite = null;
    if (!config.openRegistration) {
      const code = normaliseCode(body.invite || '');
      invite = code && db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256(code));
      if (!invite || invite.uses_left < 1 || (invite.expires_at && invite.expires_at < now())) {
        fail(403, 'invite_required');
      }
    }

    const id = rid();
    try {
      tx(db, () => {
        db.prepare(`INSERT INTO vaults (id, handle, auth_hash, invite_id, created_at)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(id, handle, sha256(authSecret), invite?.id ?? null, now());
        db.prepare(`INSERT INTO vault_keys (id, vault_id, kind, credential_id, wrapped_mk,
                                            kdf_params, label, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(rid(), id, factor.kind, factor.credentialId, factor.mk, factor.params,
               factor.label, now());
        if (invite) {
          db.prepare('UPDATE invites SET uses_left = uses_left - 1 WHERE id = ?').run(invite.id);
        }
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) fail(409, 'handle_taken');
      throw e;
    }
    json(res, 201, { vaultId: id });
  });

  /* ---------- opening one ---------- */

  // Hands back the wrapped key and the parameters needed to unwrap it. Useless
  // without the passphrase, which is why this can be answered at all — and
  // heavily rate limited, because it is the one place an attacker can collect
  // something to grind against offline.
  r.post('/v1/auth/passphrase', async (req, res) => {
    throttle(limits.unlock, 'unlock:' + ip(req));
    const body = await readJson(req, 4 * 1024);
    const handle = str(body.handle, 32)?.toLowerCase();
    if (!handle) fail(400, 'bad_handle');
    const vault = db.prepare('SELECT * FROM vaults WHERE handle = ?').get(handle);
    if (!vault) fail(404, 'no_such_vault');
    const key = db.prepare(`SELECT * FROM vault_keys WHERE vault_id = ? AND kind = 'passphrase'
                            ORDER BY created_at LIMIT 1`).get(vault.id);
    if (!key) fail(404, 'no_such_vault');
    const params = JSON.parse(key.kdf_params);
    json(res, 200, {
      vaultId: vault.id,
      epoch: vault.epoch,
      factor: { kind: 'passphrase', kdf: params.kdf, iter: params.iter, salt: params.salt, mk: key.wrapped_mk }
    });
  });

  // "Unlocked" is a secret derived from the master key: every factor that
  // opens the vault produces it, and it cannot be walked back to the key. The
  // server compares hashes and learns nothing either way.
  r.post('/v1/devices', async (req, res) => {
    throttle(limits.unlock, 'unlock:' + ip(req));
    const body = await readJson(req, 4 * 1024);
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(str(body.vaultId, 64) || '');
    if (!vault || !sameSecret(vault.auth_hash, sha256(str(body.authSecret, 512) || ''))) {
      fail(401, 'unauthorized');
    }
    const id = rid();
    const token = mintToken(id);
    db.prepare(`INSERT INTO devices (id, vault_id, token_hash, label, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, vault.id, sha256(splitToken(token).secret), str(body.label, 64), now(), now());
    json(res, 201, { deviceId: id, token, vaultId: vault.id });
  });

  r.del('/v1/devices/:id', async (req, res, params) => {
    const me = device(req);
    const target = db.prepare('SELECT * FROM devices WHERE id = ?').get(params.id);
    if (!target || target.vault_id !== me.vault_id) fail(404, 'no_such_device');
    db.prepare('DELETE FROM devices WHERE id = ?').run(params.id);
    json(res, 200, { ok: true });
  });

  /* ---------- factors ---------- */

  r.get('/v1/keys', async (req, res) => {
    const me = device(req);
    const rows = db.prepare(`SELECT id, kind, label, created_at, last_used_at
                             FROM vault_keys WHERE vault_id = ? ORDER BY created_at`).all(me.vault_id);
    json(res, 200, { keys: rows });
  });

  r.post('/v1/keys', async (req, res) => {
    const me = device(req);
    const body = await readJson(req, 16 * 1024);
    const factor = factorRow(body.factor);
    const id = rid();
    try {
      db.prepare(`INSERT INTO vault_keys (id, vault_id, kind, credential_id, wrapped_mk,
                                          kdf_params, label, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, me.vault_id, factor.kind, factor.credentialId, factor.mk, factor.params,
             factor.label, now());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) fail(409, 'already_enrolled');
      throw e;
    }
    json(res, 201, { keyId: id });
  });

  r.del('/v1/keys/:id', async (req, res, params) => {
    const me = device(req);
    const row = db.prepare('SELECT * FROM vault_keys WHERE id = ?').get(params.id);
    if (!row || row.vault_id !== me.vault_id) fail(404, 'no_such_key');
    if (row.kind === 'passphrase') {
      const left = db.prepare(`SELECT COUNT(*) n FROM vault_keys
                               WHERE vault_id = ? AND kind = 'passphrase'`).get(me.vault_id).n;
      // Removing the last passphrase leaves a vault that only a device can
      // open, and no way back in when the device is gone.
      if (left <= 1) fail(409, 'last_passphrase');
    }
    db.prepare('DELETE FROM vault_keys WHERE id = ?').run(params.id);
    json(res, 200, { ok: true });
  });

  /* ---------- sync ---------- */

  r.get('/v1/sync', async (req, res, params, url) => {
    const me = device(req);
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(me.vault_id);
    const since = Math.max(0, Number(url.searchParams.get('since') || 0) | 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 500) | 0));
    // A cursor from before the tombstones were swept cannot be merged against:
    // the deletes it never saw are gone, so it would put them all back.
    if (since && since < vault.purged_below) {
      fail(409, 'cursor_too_old', String(vault.purged_below));
    }
    const rows = db.prepare(`SELECT rec_id, seq, hlc, ciphertext, deleted FROM records
                             WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(me.vault_id, since, limit);
    json(res, 200, {
      records: rows.map(x => ({
        recId: x.rec_id, seq: x.seq, hlc: x.hlc,
        ciphertext: x.ciphertext, deleted: !!x.deleted
      })),
      next: rows.length ? rows[rows.length - 1].seq : since,
      latest: vault.seq,
      epoch: vault.epoch
    });
  });

  r.post('/v1/sync', async (req, res) => {
    const me = device(req);
    throttle(limits.write, 'push:' + me.id);
    const body = await readJson(req, config.maxRecordBytes * 64 + 65536);
    const incoming = Array.isArray(body.records) ? body.records : null;
    if (!incoming) fail(400, 'bad_records');
    if (incoming.length > 500) fail(400, 'too_many', '500 records at a time');

    for (const rec of incoming) {
      if (!rec || typeof rec !== 'object') fail(400, 'bad_records');
      if (!str(rec.recId, 64) || !str(rec.hlc, 64)) fail(400, 'bad_records');
      if (rec.ciphertext != null && String(rec.ciphertext).length > config.maxRecordBytes) {
        fail(413, 'record_too_large', rec.recId);
      }
    }

    const held = db.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) n FROM records WHERE vault_id = ?')
      .get(me.vault_id).n;
    const adding = incoming.reduce((n, x) => n + String(x.ciphertext || '').length, 0);
    if (held + adding > config.maxVaultBytes) fail(413, 'vault_full');

    const out = tx(db, () => {
      const read = db.prepare('SELECT hlc FROM records WHERE vault_id = ? AND rec_id = ?');
      const bump = db.prepare('UPDATE vaults SET seq = seq + 1 WHERE id = ?');
      const cursor = db.prepare('SELECT seq FROM vaults WHERE id = ?');
      const put = db.prepare(`INSERT INTO records (vault_id, rec_id, seq, hlc, ciphertext,
                                                   deleted, device_id, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                              ON CONFLICT(vault_id, rec_id) DO UPDATE SET
                                seq = excluded.seq, hlc = excluded.hlc,
                                ciphertext = excluded.ciphertext, deleted = excluded.deleted,
                                device_id = excluded.device_id, updated_at = excluded.updated_at`);
      const accepted = [], superseded = [];
      for (const rec of incoming) {
        const have = read.get(me.vault_id, rec.recId);
        // Last writer wins, decided on a clock the server can compare without
        // being able to read a byte of what it orders. A write that lost is
        // reported rather than dropped in silence: the client has a newer
        // version it has not seen, and needs to pull.
        if (have && have.hlc >= rec.hlc) { superseded.push(rec.recId); continue; }
        bump.run(me.vault_id);
        const seq = cursor.get(me.vault_id).seq;
        // A tombstone carries a sealed envelope too. The client cannot invert
        // an address to learn which record a delete refers to, so the envelope
        // names it — the record key and nothing else, still sealed. Whether it
        // holds a value is the client's business; the server stores what it is
        // given and could not tell the difference.
        put.run(me.vault_id, rec.recId, seq, rec.hlc,
                rec.ciphertext == null ? null : String(rec.ciphertext),
                rec.deleted ? 1 : 0, me.id, now());
        accepted.push(rec.recId);
      }
      return { accepted, superseded, latest: cursor.get(me.vault_id).seq };
    });
    json(res, 200, out);
  });

  return r;
}
