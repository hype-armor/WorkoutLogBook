# Server: sync, keys and notifications

An optional, self-hosted companion to `index.html` that does three things the
browser cannot do alone: wake a suspended phone when a rest timer ends, keep two
devices in agreement about what you lifted, and hold a copy of the log that
survives losing the phone — without being able to read any of it.

For what the app does and why, see the [README](../README.md). For how it is
built and shipped, see [development.md](development.md).

Nothing here is built yet.

## Let's name it honestly: this is an account

Earlier drafts of this design claimed "no accounts". That was true of a
notifications-only server, where a push subscription is a self-addressing
capability and identity is genuinely unnecessary.

It stops being true the moment you want sync. Sync means a second device
recognises the first one's data as *the same vault*, and restore means that
recognition survives the original device being gone. That is a durable,
device-independent identity. Calling it something else would be marketing.

So: this is an account. What it is not, and will not become:

- no email address, ever
- no password reset, because there is nobody who could perform one
- no verification, profile, avatar, or display name
- no OAuth, no SSO, no third-party identity provider
- no personal data of any kind on the server — see *what the server learns*

A handle and a passphrase, or a passkey. That is the whole of it.

## Design principles

1. **The app works with no server.** `index.html` opens from `file://` today and
   must keep doing so. Sync is a layer above local state, never underneath it.
   No API call is on the path to logging a set.
2. **The server cannot read the log.** Not a policy, a property: it holds
   ciphertext and lacks the key. This is what lets the README keep its claim.
3. **The server cannot merge, either** — which is the load-bearing consequence
   of (2). All conflict resolution happens on the clients.
4. **Restart-safe by construction.** No in-memory timers, no in-memory sessions.
5. **One container** serving the app and the API, so the API is same-origin and
   needs no configuration.
6. **No third-party services.** One image, one volume, one process.

## Keys

Everything rests on one secret the server never sees.

```
                    ┌──────────────────────────────┐
                    │   MK — vault master key      │  256-bit, random, client-generated
                    │   never leaves the device    │  never sent to the server
                    └──────────────┬───────────────┘
                                   │ HKDF
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        K_data (AES-GCM)     K_addr (HMAC)         K_alert (AES-GCM)
        record contents      record addressing     push payloads

        MK is stored only in wrapped form, once per unlock factor:

        wrap( MK, KDF(passphrase, salt) )  ──┐
                                             ├──▶  server: vault_keys rows
        wrap( MK, HKDF(passkey PRF output) ) ──┘        (opaque blobs)
```

This is envelope encryption, and the shape is chosen for one reason: **adding or
removing an unlock factor must not re-encrypt the log.** A passkey enrolled two
years in wraps the same MK the passphrase already wraps. Nothing is rewritten.

### Passphrase

The root factor, and mandatory — a vault always has one, because it is the only
factor that survives losing every device at once.

Derivation is **Argon2id** where you are willing to carry a small wasm blob, and
**PBKDF2-HMAC-SHA256 at 600,000 iterations** where you are not. PBKDF2 is native
to WebCrypto and therefore free of dependencies, which matters to a project
whose whole build step is "open the file". It is the weaker of the two against
a stolen server disk; with E2E ciphertext as the thing being protected and a
strong passphrase, it is an acceptable floor. Run it in a worker — 600k
iterations is about a second on an older phone and would otherwise jank the UI.

Store the KDF parameters in the wrapped-key row so they can be raised later
without invalidating anything.

### Passkey

A passkey authenticates; it does not, by default, produce an encryption key.
Bridging that gap needs the **WebAuthn PRF extension**, which returns a stable
pseudo-random 32 bytes for a given credential and salt — precisely what key
derivation wants.

```
create: extensions: { prf: {} }
get:    extensions: { prf: { eval: { first: SHA-256("logbook-mk" || vaultId) } } }
        → 32 bytes → HKDF → KEK → unwrap MK
```

The honest caveat: **PRF is not universal.** It needs Safari 18 / iOS 18 or
Chrome 116+, and an authenticator that supports it (iCloud Keychain does from
iOS 18). Where PRF is unavailable, the app must not offer passkey unlock at all
— a passkey that only proves presence while the passphrase still holds the key
is a login button pretending to be a factor, and it would teach users to rely on
something that cannot restore their data.

Passkeys are also per-origin, so they do not roam between two self-hosted
instances. Expected, worth saying once in the UI.

### Rotation and removal

Removing a factor deletes its wrapped-MK row. That revokes future use; it does
not un-read anything already read with it. A real compromise needs **full
rotation**: generate a new MK, re-encrypt every record, replace every wrapped
row, bump a vault epoch so stale devices are forced to re-enrol. Slow, rare, and
worth implementing before anyone needs it rather than after.

## Vault lookup and enrolment

A new device has to find the vault before it can unlock it. The two factors
answer this differently, which is a genuine convenience argument for passkeys:

- **Passkey** — a discoverable (resident) credential means the authenticator
  supplies the credential id, the server resolves the vault, and the user typed
  nothing. Tap, Face ID, done.
- **Passphrase** — needs a lookup key, because the passphrase itself must never
  be sent. That is a **handle**: a short, non-secret, user-chosen string. It is a
  username. It carries no meaning, is never displayed to anyone else, and exists
  only so the server can find one row.

Flows:

| | |
| --- | --- |
| **Create vault** | invite code + handle + passphrase → client generates MK, wraps it, POSTs the wrapped blob. The server receives a handle and a blob. |
| **Add a device** | handle + passphrase, or passkey → server returns the wrapped MK → client unwraps locally → mints a device token. |
| **Add a passkey** | while unlocked: wrap the in-memory MK under the PRF output, POST the new row. |
| **Restore after loss** | identical to *add a device*. There is no separate path, which is the point. |

## Invite codes

Vault *creation* requires an invite; everything else does not. Adding a device
to an existing vault is gated by the passphrase or passkey, which is a stronger
gate than a code.

Codes are minted by an admin subcommand (`docker run --rm IMAGE invite --uses 1
--expires 30d`), stored hashed, single-use by default, and recorded against the
vault they created so one can be traced and revoked. Without this, a publicly
reachable instance accumulates strangers' vaults — and since they are
encrypted, you cannot even tell what you are storing.

`LOGBOOK_OPEN_REGISTRATION=false` is the default and should stay that way.

## Data: records, not a blob

Whole-blob sync cannot merge. Two devices that both trained today would produce
two complete states, and last-write-wins silently discards one of them. Real
sync needs record granularity.

So the vault is a flat map of **records**, each encrypted independently:

| Local state | Record granularity | Notes |
| --- | --- | --- |
| `sets[]` | one per set | ids already exist — `index.html:2649` |
| `days{}` | one per date | done flag, pain, note |
| `bw[]` | one per date | dated readings, naturally keyed |
| `ex{}` | one per exercise | per-exercise rest target, unilateral flag |
| `pairs{}` | one per key | superset pairing |
| `settings{}` | one per setting key | so units on the phone and text size on the tablet both survive |
| `program[]` | **one record, whole** | an ordered list; per-day records would need fractional indexing for a thing that changes monthly. Not worth it. |

Concurrent *creation* is conflict-free by construction: two devices logging sets
at once produce different ids. The conflicts that actually occur are edits,
deletes, and settings — which is why plain last-writer-wins per record is
sufficient here, and a CRDT library is not.

### Tombstones — a local schema change

Deletes currently splice the array (`index.html:3976`) leaving no trace. Under
sync that is silent resurrection: a device that has not seen the delete still
holds the set, and pushes it back.

So deletion becomes a record state, not a removal. Local schema goes **v4 → v5**
and gains, per record, an HLC and a deleted flag. `migrate()` synthesises both
for existing data — one HLC at the epoch, nothing deleted.

Tombstones are purged server-side after 90 days. A device offline longer than
that cannot safely merge, so the server answers its stale cursor with `409` and
the client does a full reset: pull everything, replace local state. Rare, and
far better than resurrecting a year of deleted sets.

### Hybrid logical clocks

Wall-clock last-write-wins breaks on a phone whose clock is off, and gym phones
have wrong clocks. Each record carries an **HLC** — `(wall_ms, counter,
device_id)` — compared lexicographically. It is about thirty lines, it is
monotonic across clock skew, and `device_id` makes ties total rather than
arbitrary.

The HLC is stored **in plaintext** beside the ciphertext. That is deliberate:
it lets the server enforce last-writer-wins on data it cannot read, which
removes an entire class of lost-update round-trips. It also means the server
learns when each record changed and on which device — see the leakage list.

## Encryption details

- **Content**: AES-256-GCM under `K_data`, fresh 96-bit IV per write.
- **Addressing**: `rec_id = HMAC-SHA256(K_addr, entity || ":" || id)`, truncated
  to 128 bits. Deterministic across devices, so two devices address the same
  record identically; opaque to the server, which never learns that a record is
  a set rather than a setting.
- **AAD binding**: the GCM additional data is `rec_id || hlc`. This stops a
  malicious server swapping one record's ciphertext into another's slot, or
  replaying an old version under a new HLC — both of which are otherwise
  available to whoever holds the database.
- **Rollback defence**: clients keep a local high-water HLC per record and
  reject a pulled version that regresses. A server can withhold data; it must
  not be able to rewind it unnoticed.

## Sync protocol

A server-assigned monotonic `seq` per vault is the cursor. Not timestamps —
timestamps produce pagination bugs at equal values and depend on clocks the
server does not control.

```
GET  /v1/sync?since=<seq>&limit=500
     → { records: [ { rec_id, seq, hlc, ciphertext, deleted } ], next, latest }
     → 409 if <seq> predates the tombstone purge horizon → client full-resets

POST /v1/sync
     { records: [ { rec_id, hlc, ciphertext, deleted } ] }
     → server keeps the row with the higher HLC, per record
     → { accepted: [...], superseded: [...], latest }
```

Client loop: pull since cursor → merge into local state by HLC → push local
records newer than what came back → store new cursor. Run it on launch, on
`visibilitychange`, after a set is logged (debounced), and on a push nudge.

The push channel doubles as a sync signal: when one device writes, the server
can wake the others to pull. This is the one place where having both features
in one service genuinely pays.

## Notifications, with readable text and zero knowledge

The earlier draft proposed contentless push — an empty wake-up, with the service
worker filling in the body from local state — to keep exercise names off the
server. With a key hierarchy in place that trade is unnecessary.

**Encrypt the notification payload with `K_alert` at schedule time.** The server
stores and relays ciphertext; the service worker decrypts and shows "Rest
complete — Romanian deadlift". Rich text, and the server still learns nothing.

This needs the MK cached in IndexedDB for the service worker, since workers
cannot reach `localStorage` — which the sync layer needs anyway. If the vault is
locked the worker cannot decrypt, and falls back to a generic "Rest complete".
That degradation is correct and worth keeping rather than engineering around.

Everything else about notifications is unchanged from the previous design and
still governs: iOS delivers Web Push only to a Home-Screen-installed app,
delivery is not second-accurate so the true deadline travels in the payload and
the service worker applies the same honesty rule as `lateLabel()`, and the
in-app timer stays authoritative when the page is visible.

`new Notification()` at `index.html:2955` does not exist on iOS and never fires
there. `registration.showNotification()` is the only path, and is worth fixing
before any of this.

## What the server learns

Stating this precisely is the point of the whole design, and a vaguer claim
would be worse than none.

**Cannot see**: exercise names, weights, reps, RIR, bodyweight, pain scores,
notes, program structure, settings values, notification text, the handle→content
relationship, or even which record is which kind of thing.

**Can see**: that a vault exists and its handle; how many records it has and how
large each ciphertext is; when each record last changed and from which device
id; IP addresses and user-agents at request time; push endpoints, which reveal
the browser vendor; and roughly when you train, from write timing.

Traffic-shape metadata is the residual, and closing it fully would cost more
than it is worth here. It is disclosed rather than defended.

## Server schema

```sql
CREATE TABLE vaults (
  id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE,
  epoch INTEGER NOT NULL DEFAULT 1,       -- bumped on full MK rotation
  invite_id TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE vault_keys (                 -- wrapped MK, one row per factor
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- 'passphrase' | 'passkey'
  credential_id TEXT,                     -- passkey only; NULL for passphrase
  wrapped_mk BLOB NOT NULL, kdf_params TEXT NOT NULL,
  label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, label TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);

CREATE TABLE records (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  rec_id BLOB NOT NULL, seq INTEGER NOT NULL,
  hlc TEXT NOT NULL,                      -- plaintext, for server-side LWW
  ciphertext BLOB, deleted INTEGER NOT NULL DEFAULT 0,
  device_id TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, rec_id)
);
CREATE INDEX records_cursor ON records(vault_id, seq);

CREATE TABLE invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
  uses_left INTEGER NOT NULL DEFAULT 1, expires_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE push_subs (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY, sub_id TEXT NOT NULL REFERENCES push_subs(id) ON DELETE CASCADE,
  fire_at INTEGER NOT NULL, payload BLOB NOT NULL,   -- ciphertext under K_alert
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX alerts_due ON alerts(state, fire_at);
```

## API

| Route | Auth | |
| --- | --- | --- |
| `GET /v1/config` | none | VAPID public key, KDF defaults, whether registration is open |
| `POST /v1/vaults` | invite | create: handle + wrapped MK |
| `POST /v1/auth/passphrase` | handle | returns the wrapped MK blob and KDF params |
| `POST /v1/auth/passkey/*` | WebAuthn | challenge / assertion; returns the wrapped MK |
| `POST /v1/devices` | unlocked | mint a device token |
| `DELETE /v1/devices/:id` | device | revoke; cascades its push subscription |
| `POST /v1/keys` | device | enrol another factor (a passkey) |
| `DELETE /v1/keys/:id` | device | remove a factor; never the last passphrase |
| `GET /v1/sync` | device | pull since cursor |
| `POST /v1/sync` | device | push records |
| `POST /v1/push/subscribe` | device | |
| `POST /v1/alerts` | device | `{fire_at, payload}` — payload is ciphertext |
| `PATCH`/`DELETE /v1/alerts/:id` | device | reschedule / cancel |
| `GET /healthz`, `/readyz` | none | unversioned |

Returning the wrapped MK to anyone who names a handle is deliberate — it is
useless without the passphrase — but it is an offline-attack surface, so
`/v1/auth/passphrase` is the most aggressively rate-limited route on the server.

## The scheduler

Unchanged from the notifications-only design and still the right shape: a
one-second poll claiming rows before sending, in a single statement, so
overlapping ticks cannot double-send.

```sql
UPDATE alerts SET state='sent', sent_at=:now, attempts=attempts+1
WHERE id IN (SELECT id FROM alerts WHERE state='pending' AND fire_at<=:now
             ORDER BY fire_at LIMIT 100)
RETURNING *;
```

A restart loses nothing — there are no in-memory timers to rebuild. On `410` or
`404` from the push service, delete the subscription; on `429`, respect
`Retry-After` and leave the row.

## Packaging

One multi-arch image (`amd64`, `arm64` — k3s on a Pi is a likely home for this),
non-root, read-only root filesystem, one writable volume, config by environment,
structured logs to stdout, graceful `SIGTERM`.

| Variable | Default | |
| --- | --- | --- |
| `LOGBOOK_VAPID_PUBLIC` / `_PRIVATE` / `_SUBJECT` | — | required; private is a secret |
| `LOGBOOK_DB` | `/data/logbook.db` | on the volume |
| `LOGBOOK_PORT` | `8080` | |
| `LOGBOOK_SERVE_STATIC` | `true` | same-origin API needs no client configuration |
| `LOGBOOK_ALLOWED_ORIGINS` | empty | only when not serving static |
| `LOGBOOK_OPEN_REGISTRATION` | `false` | invite required to create a vault |
| `LOGBOOK_KDF` | `pbkdf2` | or `argon2id` |
| `LOGBOOK_KDF_ITERATIONS` | `600000` | advertised via `/v1/config` |
| `LOGBOOK_TOMBSTONE_DAYS` | `90` | purge horizon |
| `LOGBOOK_MAX_RECORD_BYTES` | `65536` | |
| `LOGBOOK_MAX_VAULT_BYTES` | `52428800` | 50 MB is roughly a lifetime of lifting |

Generate the VAPID keypair once (`docker run --rm IMAGE vapid`) and back up the
private key. Rotating it silently invalidates every subscription with no error
anywhere.

## Compose, Swarm, Kubernetes

Same image everywhere; only the volume and the replica constraint differ.

**Exactly one replica.** SQLite over a network mount corrupts under two writers,
and two schedulers double-send. This is not a scaling limit worth worrying about
— a household of lifters will not trouble one small container — but it must be
enforced rather than assumed:

- **Compose** — a named volume, `restart: unless-stopped`.
- **Swarm** — `replicas: 1`, `endpoint_mode: dnsrr`, and `order: stop-first`,
  because the default `start-first` briefly runs two tasks against one database.
  A node constraint, since the volume is local.
- **Kubernetes / k3s** — `replicas: 1` with `strategy.type: Recreate`, *not*
  `RollingUpdate`, for the same reason. A `ReadWriteOnce` PVC. VAPID keys and
  the invite-signing secret in a `Secret`, the rest in a `ConfigMap`. Liveness
  `/healthz`, readiness `/readyz`, `terminationGracePeriodSeconds: 30`. Requests
  around 32Mi/10m. A Kustomize base with overlays rather than a Helm chart —
  there are a dozen values worth changing.

**Backups now matter**, in a way they did not when this was only a scheduler:
this is a system of record. The compensation is that they are free of risk —
the volume holds nothing but ciphertext, so the SQLite file can be replicated to
any storage you like without extending trust to it.

**Scale path**, should it ever be needed: Postgres, the identical claim-then-send
statement with `FOR UPDATE SKIP LOCKED`, and an advisory lock so only one
scheduler is live. The sync endpoints are already stateless. Do not build this
now.

## Security

**SSRF through the push endpoint** remains the single most important check in
the codebase. `POST /v1/push/subscribe` accepts a URL the server will later
fetch; unvalidated, it is a proxy into your LAN or a cloud metadata endpoint.
Allowlist the host against known push services and refuse to follow redirects.

**Offline attack on the wrapped MK.** Anyone who can reach the server can ask
for a handle's wrapped key. That is inherent to letting a new device restore
with nothing but a passphrase. Mitigate with a strong KDF, aggressive rate
limiting on that one route, and guidance in the UI that generates a passphrase
rather than accepting a weak typed one.

**A malicious server** is in scope by construction. It cannot read or forge
records — AAD binding sees to that — but it can withhold or rewind them, which
the client-side HLC high-water mark detects.

Beyond that: hash device tokens and invite codes at rest, never log endpoints,
tokens or handles, and cap record and vault sizes so one client cannot fill the
disk.

## Testing

The existing 293 Playwright tests must pass unchanged with no server running.
That is rule 1 expressed as a suite, and the reason the sync client belongs in
one injectable module rather than scattered `fetch` calls.

Then, in layers:

- **Crypto** — wrap/unwrap round-trips for both factors; AAD rejection on a
  swapped `rec_id`; PRF-unavailable path takes the passphrase branch.
- **Merge** — two simulated clients, offline edits to the same record,
  convergence to the same state regardless of push order; a delete on A not
  resurrected by B; skewed clocks resolved by HLC rather than wall time.
- **Protocol** — cursor paging, `409` on a stale cursor triggering full reset,
  server-side LWW keeping the higher HLC.
- **Server** — claim-then-send under concurrent ticks; endpoint allowlist;
  invite single-use; rate limits.
- **On a real phone** — install to Home Screen, start a rest timer, lock it,
  pocket it. Nothing else proves the part that matters.

## Repository layout

```
server/            # its own package.json; the root stays build-free
  src/
  Dockerfile
deploy/
  compose.yml
  stack.yml        # swarm
  k8s/             # kustomize base + overlays
docs/server.md
```

`index.html` stays one file at the root that opens from disk. If `server/` were
deleted the app would still work — that is the property worth protecting.

## What this changes about the project

The README opens with "no account, no server and no sync … nothing is uploaded
anywhere." All three clauses are about to be optionally false.

The honest rewrite is not a softening but a sharper claim: *there is no account
unless you make one; if you do, the server holds ciphertext it cannot read, and
the app works exactly as before without it.* That is a stronger statement than
the current one, and it has to be earned by the design rather than asserted —
which is what the leakage list above is for.

## Order of work

1. ~~`registration.showNotification()` in place of `new Notification()`, and
   honesty about `vibrate` on iOS.~~ **Done.** No server involved; it fixed a
   feature that was broken on every iPhone.
2. ~~Local schema v4 → v5: per-record HLC, tombstones, `migrate()` synthesising
   both.~~ **Done.** `db.rev` maps a record key to `{h, del}`; stamping works by
   diffing against a snapshot in `save()` rather than by calling a function at
   each of the sixty-odd sites that change something, because one of those
   would be forgotten and a forgotten one is a change that syncs as though it
   never happened. The device id lives outside the database, in `logbook-device`,
   so a restored backup does not clone it. Nothing reads any of it yet — except
   restore, which no longer hands back a set you deleted.
3. ~~The crypto module: MK generation, HKDF subkeys, both wrap paths, AES-GCM
   with AAD.~~ **Done.** `vault` in `index.html`, WebCrypto only, no
   dependencies. Thirteen tests in `tests/vault.spec.js`, most of them about
   what a hostile server *cannot* do with the ciphertext it holds: move a
   record into another's slot, put an old version back under a newer clock, or
   change a byte. PBKDF2 at 600,000 rounds measures about 90ms on a desktop
   here — a phone will be several times that, which is why it belongs in a
   worker before it sits behind a button.
4. The server: schema, vault and auth routes, invites, sync endpoints.
5. The sync client: pull/merge/push loop, cursor persistence, full-reset path.
6. Push, now with encrypted payloads, plus the sync nudge.
7. The container and the three deployment targets.
8. A real phone, in a pocket, for three minutes — and a second device.

Steps 1 and 2 are worth doing on their own merits whether or not the rest ever
ships.
