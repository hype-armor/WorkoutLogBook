// Schema and migrations. One file, one numbered list: `PRAGMA user_version` is
// the only state, and a migration is only ever appended. Never edited — an
// edited migration is one that ran differently on the machine that already
// applied it, which is the class of bug you find months later on the one
// deployment you cannot reproduce.
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1 — vaults, the keys that open them, the devices that speak for them, the
  // records they hold, and the invites that let them exist.
  `
  CREATE TABLE vaults (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE,
    -- sha256 of a secret derived from the master key. Proves a client unlocked
    -- the vault, to a server that holds neither the passphrase nor the key.
    auth_hash    TEXT NOT NULL,
    epoch        INTEGER NOT NULL DEFAULT 1,   -- bumped on a full key rotation
    seq          INTEGER NOT NULL DEFAULT 0,   -- the sync cursor, per vault
    purged_below INTEGER NOT NULL DEFAULT 0,   -- cursors older than this cannot merge
    invite_id    TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE vault_keys (
    id            TEXT PRIMARY KEY,
    vault_id      TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,               -- 'passphrase' | 'passkey'
    credential_id TEXT,                        -- passkey only
    wrapped_mk    TEXT NOT NULL,               -- opaque; the server cannot open it
    kdf_params    TEXT NOT NULL,               -- JSON, so they can be raised later
    label         TEXT,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );
  CREATE INDEX vault_keys_vault ON vault_keys(vault_id);
  CREATE UNIQUE INDEX vault_keys_cred ON vault_keys(credential_id)
    WHERE credential_id IS NOT NULL;

  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX devices_vault ON devices(vault_id);

  CREATE TABLE records (
    vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    rec_id     TEXT NOT NULL,                  -- an HMAC the server cannot invert
    seq        INTEGER NOT NULL,
    -- Plaintext on purpose: it is what lets the server keep the newer of two
    -- versions of something it cannot read.
    hlc        TEXT NOT NULL,
    ciphertext TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, rec_id)
  );
  CREATE INDEX records_cursor ON records(vault_id, seq);

  CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL UNIQUE,
    uses_left  INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER,
    note       TEXT,
    created_at INTEGER NOT NULL
  );
  `,

  // 2 — the only thing a browser can do that a page cannot: wake a phone that
  // has suspended the app. A subscription belongs to a device, so revoking the
  // device takes the subscription with it.
  `
  CREATE TABLE push_subs (
    id         TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    fail_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_subs_device ON push_subs(device_id);

  CREATE TABLE alerts (
    id         TEXT PRIMARY KEY,
    sub_id     TEXT NOT NULL REFERENCES push_subs(id) ON DELETE CASCADE,
    fire_at    INTEGER NOT NULL,
    -- Ciphertext under a key derived from the vault's master key. The server
    -- relays it; the service worker is what can read it.
    payload    TEXT NOT NULL,
    state      TEXT NOT NULL,          -- 'pending' | 'sent' | 'failed' | 'cancelled'
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sent_at    INTEGER
  );
  CREATE INDEX alerts_due ON alerts(state, fire_at);
  `
];

export function open(path) {
  const db = new DatabaseSync(path);
  // WAL so a read never blocks the write that a push is in the middle of.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db) {
  const at = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = at; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return MIGRATIONS.length;
}

/** All or nothing. A half-applied push would leave the cursor lying. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
