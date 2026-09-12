# Notifications

How Logbook could get an alert onto a phone that is in a pocket with the screen
off — the one thing the app cannot do today — without an App Store account, a
SaaS bill, or giving up the property that the app works with no server at all.

For what the app does and why, see the [README](../README.md). For how it is
built and shipped, see [development.md](development.md).

## The problem this solves

The rest timer fires from a 250ms interval on the page. iOS suspends a
backgrounded home-screen app outright, so the interval stops, and nothing in the
browser can restart it. `index.html` already admits this twice — once in
`ALERT_OPTIONS`, once in the comment above `LATE_GRACE` — and the app's
current best behaviour is to *stop pretending* on the way back, saying
"4 min ago" rather than "Rest complete".

Web Push is the only mechanism that wakes a suspended web app. It needs a
server to send the push. That is the entire reason this document exists.

## What it does not solve

Three limits are inherent, not implementation details, and the design below is
shaped around them rather than trying to beat them.

**The app must be on the Home Screen.** iOS supports Web Push from 16.4, but
only for web apps added to the Home Screen — never in a Safari tab. The
permission flow has to detect this and explain the install step first, or a user
taps "enable notifications", grants permission, and receives nothing forever.
Android and desktop have no such restriction and work from a tab today.

**Delivery is not second-accurate.** A push may land seconds late. For a rest
timer that matters: an alert that says "Rest complete" ninety seconds late
reports something untrue, which is exactly the failure `lateLabel()` was written
to avoid. The fix is not to chase accuracy but to carry the real deadline in the
push and let the service worker apply the same honesty rule the page already
applies — past the grace window it says how late it is.

**The in-app timer stays authoritative.** Push is the backstop for a pocketed
phone, not the mechanism. When the page is visible it alerts as it does now, and
the service worker suppresses the push. The existing `tag: 'logbook-rest'` is
already the right dedupe key.

## The one hop you cannot self-host

Web Push does not deliver browser-to-server. The client subscribes to a **push
service run by its browser vendor** — `web.push.apple.com` for Safari,
`fcm.googleapis.com` for Chrome, `updates.push.services.mozilla.com` for
Firefox — and hands your server that endpoint URL. Your server signs a request
to it. There is no way to self-host that hop, because the endpoint is chosen by
the user's browser, not by you.

What that is *not*, which is the part that matters here:

- **No account.** You never register with Apple, Google or Mozilla.
- **No API key, no quota, no bill.** Authentication is VAPID: a keypair you
  generate yourself, whose public half the client subscribes with.
- **No readable data.** The payload is encrypted end-to-end with keys the client
  generated. The push service relays ciphertext it cannot open.

So "no third-party services" holds in every sense that costs money, creates an
account, or leaks data. There is one protocol-level relay, and the design below
sends it nothing worth reading anyway.

The other unavoidable third party is a **certificate authority**: browsers
require HTTPS for service workers and refuse mixed content, so a publicly
reachable deployment needs a real certificate. Let's Encrypt via Caddy or
Traefik is the default. On a LAN-only deployment an internal CA works, provided
the phone trusts it.

## Design principles

Everything below follows from five rules. When a decision looks arbitrary, it is
one of these.

1. **The app works with no server.** `index.html` opens from `file://` today and
   must keep doing so. No API call is ever on the path to logging a set. Any
   server failure degrades to "no push today", silently.
2. **The server never sees training data.** Not exercise names, not weights, not
   pain scores. This is what keeps the README's claim honest, and it is
   achievable at zero cost to the feature — see *contentless push* below.
3. **No accounts.** A push subscription is already an anonymous capability. The
   device that created it is the only thing that needs to address it.
4. **Restart-safe by construction.** The scheduler holds nothing in memory. A
   `SIGTERM` mid-rest loses no alert, because the alert lives in the database
   and the schedule is derived from it on every tick.
5. **One container.** The default deployment serves the app *and* the API from a
   single image. That removes CORS entirely, makes the API same-origin and
   therefore discoverable without configuration, and means a self-hoster runs
   one thing.

## Architecture

```
  ┌───────────────────────┐
  │ iPhone (Home Screen)  │
  │                       │      1. subscribe        ┌──────────────────────┐
  │  index.html ──────────┼──────────────────────────▶                      │
  │      │                │      2. schedule alert   │   logbook-push       │
  │      │ logbook-v1     │         (deadline only)  │   ┌────────────────┐ │
  │      ▼ localStorage   │◀─────────────────────────┤   │ API            │ │
  │   (never leaves)      │         3. cancel        │   ├────────────────┤ │
  │                       │                          │   │ scheduler      │ │
  │  sw.js                │                          │   └───────┬────────┘ │
  │   push ──▶ IndexedDB  │                          │           │          │
  │            (text)     │                          │      SQLite (volume) │
  └───────────▲───────────┘                          └───────────┬──────────┘
              │                                                  │
              │        ┌──────────────────────────┐              │
              └────────┤ vendor push service      │◀─────────────┘
                 5.    │ apple / google / mozilla │   4. encrypted, contentless
                       └──────────────────────────┘
```

One process, two concerns. The API accepts subscriptions and alert schedules.
The scheduler polls the database and sends. They share a binary because at this
size splitting them buys nothing but a second thing to deploy — and if you ever
do split them, the only rule is that **exactly one scheduler runs at a time**.

## Contentless push

The push payload is encrypted end-to-end, so the vendor cannot read it. But your
*server* would compose it, which puts "Rest complete — Romanian deadlift" in
your logs and your database.

Instead the server sends a wake-up carrying only what it already knows: an alert
id, the true deadline, and a kind (`rest` or `transition`). The service worker
fills in the body from local state. The server learns that *a* timer ends at
*a* time, and nothing else.

One gotcha this creates: **service workers cannot read `localStorage`** — it is
synchronous and not exposed to worker scope. The page must mirror the pending
alert's display text into a one-record IndexedDB store alongside `persistRest()`.
That is the only storage change; `logbook-v1` keeps its shape.

## Data model

Two tables. No user table.

```sql
CREATE TABLE subscriptions (
  id          TEXT PRIMARY KEY,      -- opaque random, not derived from anything
  endpoint    TEXT NOT NULL UNIQUE,  -- vendor push URL
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,         -- sha256 of the bearer token; never the token
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  fail_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE alerts (
  id         TEXT PRIMARY KEY,
  sub_id     TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  fire_at    INTEGER NOT NULL,       -- epoch ms, the true deadline
  kind       TEXT NOT NULL,          -- 'rest' | 'transition'
  state      TEXT NOT NULL,          -- 'pending' | 'sent' | 'failed' | 'cancelled'
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);

CREATE INDEX alerts_due ON alerts(state, fire_at);
```

Losing this database is a nuisance, not a loss: every device resubscribes on
next launch and the worst case is one missed rest timer. That is worth knowing
because it sets how much backup ceremony is justified — very little.

## API

Five routes, versioned from the first commit, because a cached `index.html` will
outlive any deploy and must keep working against a newer server.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/config` | none | returns the VAPID public key so the client can subscribe |
| `POST /v1/subscribe` | none | body is the `PushSubscription` JSON; returns `{id, token}` |
| `POST /v1/alerts` | bearer | `{fire_at, kind}`; returns `{alert_id}` |
| `PATCH /v1/alerts/:id` | bearer | new `fire_at` — the rest target changed mid-timer |
| `DELETE /v1/alerts/:id` | bearer | timer stopped, skipped, or the next set was logged |
| `DELETE /v1/subscribe` | bearer | notifications turned off; row deleted, not flagged |

`GET /healthz` (liveness) and `GET /readyz` (readiness, checks the database
opens) sit outside `/v1` and are never versioned.

**Auth is a bearer token minted at subscribe time**, stored on the device beside
the subscription and hashed at rest on the server. It authorises exactly one
thing: scheduling alerts to the device that created it. That is authorisation
without identity, which is all this needs.

## The scheduler

A poll loop, not a queue. Once a second:

```sql
UPDATE alerts SET state = 'sent', sent_at = :now, attempts = attempts + 1
WHERE id IN (
  SELECT id FROM alerts
  WHERE state = 'pending' AND fire_at <= :now
  ORDER BY fire_at LIMIT 100
)
RETURNING *;
```

Claiming the row **before** sending, in one statement, is what makes this safe:
two ticks that overlap, or two replicas that should not both be running, cannot
double-send. A send that then fails is visible as `state='sent'` with no
delivery, which is the right trade — a duplicate "Rest complete" is worse than a
missing one, because the user is already looking at a green timer.

A restart loses nothing. There are no in-memory timers to rebuild; the next tick
picks up whatever is due, including alerts that came due while the process was
down. Those fire late, and the honesty rule handles it.

On `410 Gone` or `404` from the push service, delete the subscription — that is
how you learn someone removed the app. On `429`, respect `Retry-After` and leave
the row for the next tick.

## Frontend changes

**`sw.js` gains handlers it does not have.** There is no `push` or
`notificationclick` listener today. Both are new. `notificationclick` should
focus an existing client rather than opening a second one.

**`new Notification()` at `index.html:2955` has to go** regardless of whether
the server ships. The constructor does not exist on iOS and never fires there,
so the notify toggle is currently dead on the platform it was written for.
`registration.showNotification()` is the only path, and it is what push requires
anyway. This is worth doing as its own change, ahead of any server.

**The scheduling hooks already exist.** `persistRest()` writes exactly what the
scheduler needs, and the three places it is called from map one-to-one onto the
API:

| Existing code | Call |
| --- | --- |
| `startRest()` — `index.html:2994` | `POST /v1/alerts` at `start + target` |
| `stopRest()` — `index.html:3035` | `DELETE /v1/alerts/:id` |
| rest-target cycling — `index.html:4005` | `PATCH /v1/alerts/:id` |

All three fire-and-forget. A failed request never blocks the UI and never
surfaces an error; the local timer is unaffected.

**Server discovery needs no configuration in the default case.** Try same-origin
`/v1/config` first — which is what a self-hoster serving both from one container
gets for free. Fall back to an optional URL in Settings for anyone running the
app from GitHub Pages against their own server elsewhere. Empty and unreachable
both mean the same thing: push is off, everything else works.

**`navigator.vibrate` at `index.html:2944` is a no-op on iOS**, so "Vibration
only" in `ALERT_OPTIONS` is silence on an iPhone. Unrelated to push, but it is
the same honesty problem and worth fixing in the same pass.

## Packaging

A single image, because rule 5. Properties that matter for the orchestrators:

- **Multi-arch**: `linux/amd64` and `linux/arm64`. k3s on a Pi is a likely
  deployment and the second most likely is a cheap ARM VPS.
- **Non-root**, read-only root filesystem, one writable volume for the database.
- **Config by environment**, no config file, no baked-in defaults that differ
  between environments.
- **Structured logs to stdout.** No log files, nothing to rotate.
- **Graceful `SIGTERM`**: stop accepting requests, finish the in-flight tick,
  close the database. Under ten seconds; `terminationGracePeriodSeconds: 30` is
  generous.

| Variable | Default | |
| --- | --- | --- |
| `LOGBOOK_VAPID_PUBLIC` | — | required |
| `LOGBOOK_VAPID_PRIVATE` | — | required, secret |
| `LOGBOOK_VAPID_SUBJECT` | — | `mailto:` or `https:` contact, required by spec |
| `LOGBOOK_DB` | `/data/push.db` | on the volume |
| `LOGBOOK_PORT` | `8080` | |
| `LOGBOOK_SERVE_STATIC` | `true` | serve `index.html` and friends from the same origin |
| `LOGBOOK_ALLOWED_ORIGINS` | empty | only needed when not serving static |
| `LOGBOOK_MAX_PENDING` | `5` | pending alerts per subscription |
| `LOGBOOK_MAX_HORIZON_S` | `86400` | furthest a `fire_at` may be scheduled |

Generate the keypair once with a subcommand (`docker run --rm IMAGE vapid`) and
**back up the private key**. Rotating it silently invalidates every existing
subscription — every device stops receiving and nothing reports an error.

## Compose, Swarm and Kubernetes

The same image in all three. What differs is only how the volume and the
single-replica constraint are expressed.

**The constraint that governs every target: SQLite means exactly one replica.**
Two processes on one database file over a network mount corrupt it, and two
schedulers double-send. This is not a scaling problem in practice — one small
container handles a household of lifters without noticing — but it must be
enforced rather than assumed.

- **Compose**: a named volume, `restart: unless-stopped`. Nothing else.
- **Swarm**: `replicas: 1`, `endpoint_mode: dnsrr`, and `order: stop-first` in
  the update config — the default `start-first` briefly runs two tasks, which is
  the one thing that must not happen. Pin to a node with a constraint, since the
  volume is local.
- **Kubernetes / k3s**: a `Deployment` with `replicas: 1` and
  `strategy.type: Recreate` — *not* `RollingUpdate`, for the same reason. A
  `PersistentVolumeClaim` with `ReadWriteOnce`. VAPID keys in a `Secret`, the
  rest in a `ConfigMap`. Liveness on `/healthz`, readiness on `/readyz`.
  Requests around 32Mi/10m, limits 128Mi/500m. Ship a Kustomize base with
  overlays rather than a Helm chart; there are perhaps twelve values worth
  changing and a chart would be more machinery than the thing it deploys.

**If you ever outgrow one replica** — which means many users, not many
subscriptions — swap SQLite for Postgres and keep the identical claim-then-send
statement with `FOR UPDATE SKIP LOCKED`. The API then scales freely; the
scheduler still wants a leader, or an advisory lock. Do not build this now.

## Security

Two risks are specific to a self-hosted push server and worth naming.

**SSRF through the subscription endpoint.** `POST /v1/subscribe` accepts a URL
and your server later makes requests to it. Unvalidated, anyone can register an
endpoint pointing at `169.254.169.254` or something on your LAN and use your
server as a proxy into it. **Validate the endpoint host against an allowlist of
known push services** and reject anything else, including redirects. This is the
single most important line of code in the project.

**Anonymous write access.** No accounts means anyone who finds the URL can
subscribe. The caps are what make that safe and they are cheap: pending alerts
per subscription, a maximum scheduling horizon, rate limits per token and per
IP, and a global subscription cap for a private instance. None of it needs
identity.

Beyond that: hash the bearer token at rest, never log endpoints or tokens, and
prune `sent` alerts after 24 hours. There is no PII to leak because none is ever
collected.

## Testing

The existing 293 Playwright tests must pass unchanged, with no server running.
That is not just a convenience — it is rule 1 expressed as a test suite, and it
is the reason the API client should be one injectable module rather than `fetch`
calls scattered through `index.html`.

Add, in layers:

- **Unit**: the claim-then-send statement under concurrent ticks; endpoint
  allowlist rejection; horizon and pending caps.
- **Stub**: extend `tests/server.js` with the six routes returning canned
  responses, so the subscribe flow and the settings UI are testable without a
  real push service.
- **Integration**: a container, a real SQLite file, a fake push endpoint that
  records deliveries. Schedule, restart the process mid-wait, assert the alert
  still fires.
- **Manual, on a real phone**: it is the only way to verify the part that
  matters. Install to Home Screen, start a rest timer, lock the phone, pocket
  it. Nothing else proves this works.

## Repository layout

```
server/            # its own package.json; the root stays build-free
  src/
  Dockerfile
deploy/
  compose.yml
  stack.yml        # swarm
  k8s/             # kustomize base + overlays
docs/notifications.md
```

`index.html` stays a single file at the root that opens from disk. The server is
a sibling, not a dependency — if `server/` were deleted the app would still
work, which is the property worth protecting.

## What this changes about the project

The README opens with "no account, no server and no sync … nothing is uploaded
anywhere." After this there is a server, and one narrow channel to it.

The claim survives with an edit, because the design makes it literally true:
training data never leaves the device, the server holds a push address and a
timestamp, and the whole thing is opt-in and removable — turning notifications
off deletes the row. But the sentence needs rewriting deliberately, as a product
decision, rather than being quietly falsified in a diff.

## Order of work

1. `showNotification()` in place of `new Notification()`, and honesty about
   `vibrate` on iOS. No server involved; fixes a feature that is broken today.
2. `push` and `notificationclick` handlers in `sw.js`, plus the IndexedDB mirror
   for the alert text. Still no server: testable with DevTools' push simulator.
3. The server — schema, five routes, poll loop, endpoint allowlist.
4. The container and the three deployment targets.
5. The client half: subscribe flow, Home Screen detection, same-origin
   discovery, the three scheduling hooks.
6. A real phone, in a pocket, for three minutes.

Each step is useful on its own, and the first two ship value whether or not the
rest ever does.
