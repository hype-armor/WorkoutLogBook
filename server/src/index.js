// Entry point and configuration. Everything is an environment variable, so the
// same image runs under Compose, Swarm and Kubernetes with nothing but the
// environment changed.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { open } from './db.js';
import { routes } from './routes.js';
import { HttpError, json, serveStatic } from './http.js';
import { rid, sha256, inviteCode, normaliseCode } from './ids.js';

const here = dirname(fileURLToPath(import.meta.url));
const bool = (v, dflt) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const perHour = (v, dflt) => {
  const n = Number(v) > 0 ? Number(v) : dflt;
  return { capacity: n, perSecond: n / 3600 };
};
const perMinute = (v, dflt) => {
  const n = Number(v) > 0 ? Number(v) : dflt;
  return { capacity: n, perSecond: n / 60 };
};

export function configure(env = process.env) {
  return {
    port: Number(env.LOGBOOK_PORT || 8080),
    host: env.LOGBOOK_HOST || '0.0.0.0',
    dbPath: env.LOGBOOK_DB || '/data/logbook.db',
    // The app and the API from one origin: no CORS, and no URL for anyone to
    // type into a settings field.
    staticRoot: bool(env.LOGBOOK_SERVE_STATIC, true)
      ? resolve(env.LOGBOOK_STATIC_ROOT || join(here, '..', '..'))
      : null,
    allowedOrigins: String(env.LOGBOOK_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    openRegistration: bool(env.LOGBOOK_OPEN_REGISTRATION, false),
    kdfIterations: Number(env.LOGBOOK_KDF_ITERATIONS || 600000),
    maxRecordBytes: Number(env.LOGBOOK_MAX_RECORD_BYTES || 65536),
    maxVaultBytes: Number(env.LOGBOOK_MAX_VAULT_BYTES || 52428800),
    vapidPublic: env.LOGBOOK_VAPID_PUBLIC || null,
    // Off unless the deployment says otherwise: an x-forwarded-for header is
    // whatever the client claims, and trusting it unasked hands every caller a
    // fresh rate limit for free.
    trustProxy: bool(env.LOGBOOK_TRUST_PROXY, false),
    // Per address, and every phone in a house shares one address, so these are
    // configurable rather than fixed: five unlocks an hour is right for a
    // server on the open internet and wrong for a family behind one NAT. The
    // burst is the allowance — spend it at once or spread it out.
    limits: {
      unlock: perHour(env.LOGBOOK_LIMIT_UNLOCK_PER_HOUR, 5),
      create: perHour(env.LOGBOOK_LIMIT_CREATE_PER_HOUR, 3),
      write: perMinute(env.LOGBOOK_LIMIT_WRITE_PER_MIN, 120)
    }
  };
}

export function createApp(config) {
  const db = open(config.dbPath);
  const ctx = { db, config };
  const r = routes(ctx);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Only when the app is served from somewhere else; same-origin needs none
    // of this, which is the reason same-origin is the default.
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/readyz') {
      try { db.prepare('SELECT 1 AS ok').get(); return json(res, 200, { ok: true }); }
      catch { return json(res, 503, { ok: false }); }
    }

    const hit = r.match(req.method, url.pathname);
    if (hit) {
      try {
        await hit.handler(req, res, hit.params, url);
      } catch (e) {
        if (e instanceof HttpError) json(res, e.status, { error: e.code, detail: e.detail ?? null });
        else {
          // Never the message: it can carry a row's contents, and a stack has
          // no business reaching a client.
          console.error('unhandled', e);
          json(res, 500, { error: 'internal' });
        }
      }
      ctx.sweep();
      return;
    }

    // An unmatched /v1 path is a bug or a probe, never a file.
    if (url.pathname.startsWith('/v1/')) return json(res, 404, { error: 'no_such_route' });
    if (config.staticRoot && (req.method === 'GET' || req.method === 'HEAD')) {
      if (await serveStatic(config.staticRoot, req, res)) return;
    }
    json(res, 404, { error: 'not_found' });
  });

  server.on('close', () => { try { db.close(); } catch { /* already closed */ } });
  return { server, db, config };
}

/** `invite` mints a code; without a subcommand the server starts. */
async function main(argv) {
  const config = configure();
  if (argv[0] === 'invite') {
    const db = open(config.dbPath);
    const uses = Number(argv[argv.indexOf('--uses') + 1]) || 1;
    const days = Number(String(argv[argv.indexOf('--expires') + 1] || '').replace(/\D/g, '')) || 0;
    const code = inviteCode();
    db.prepare(`INSERT INTO invites (id, code_hash, uses_left, expires_at, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(rid(), sha256(normaliseCode(code)), uses, days ? Date.now() + days * 86400000 : null,
           argv.includes('--note') ? argv[argv.indexOf('--note') + 1] : null, Date.now());
    db.close();
    // The only time it is ever readable: the server keeps a hash.
    process.stdout.write(code + '\n');
    return;
  }

  const { server } = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ at: 'listening', port: config.port, db: config.dbPath,
      static: !!config.staticRoot, openRegistration: config.openRegistration }));
  });

  // Finish what is in flight, then go. Nothing is held in memory that a
  // restart would lose, so this is politeness rather than correctness.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(JSON.stringify({ at: 'stopping', sig }));
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
}
