// A router, a JSON body reader and a static file handler. No framework: there
// are fourteen routes, and a dependency here would be the only one in the
// project.
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
export const fail = (status, code, detail) => { throw new HttpError(status, code, detail); };

export function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(text);
}

/**
 * Read a JSON body, refusing anything oversized before it is in memory rather
 * than after. `limit` is bytes.
 */
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(new HttpError(413, 'too_large'));
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}

/**
 * Routes are `METHOD /literal/:param` and matched in order. Enough for an API
 * this size, and it fails loudly on an unmatched path rather than falling
 * through to the static handler and answering a typo with index.html.
 */
export function router() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ method, parts, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    del: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      const parts = pathname.split('/').filter(Boolean);
      for (const r of routes) {
        if (r.method !== method || r.parts.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
          if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
          else if (r.parts[i] !== parts[i]) { ok = false; break; }
        }
        if (ok) return { handler: r.handler, params };
      }
      return null;
    }
  };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * What the app is made of, and nothing else. An allowlist rather than "the
 * directory minus the dangerous bits", because the directory is a git checkout:
 * it holds the tests, the server's own source, `.git`, and — if someone points
 * LOGBOOK_DB at a relative path — the database itself. Every one of those was
 * reachable when this served whatever it found, and the encrypted vault being
 * downloadable is exactly the failure the encryption exists to survive.
 *
 * The list is the same one the service worker precaches, which is the honest
 * definition of "the app".
 */
const APP_FILE = [
  /^index\.html$/,
  /^sw\.js$/,
  /^manifest\.webmanifest$/,
  /^version\.txt$/,
  /^[a-z0-9-]+\.png$/,          // the icons
  /^img\/[a-z0-9-]+\.webp$/     // the exercise photos
];

/**
 * Serve the app from the same origin as the API. That is the whole reason this
 * exists: same origin means no CORS, and no URL for anyone to configure.
 */
export async function serveStatic(root, req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  // normalize() before matching, so `img/../sw.js` is judged as what it is.
  const rel = normalize(p).replace(/^[/\\]+/, '');
  if (!APP_FILE.some(re => re.test(rel))) return false;

  // Belt and braces: the patterns above cannot express `..`, but a path that
  // reaches the filesystem should be confirmed to be where it claims anyway.
  const file = join(root, rel);
  if (file !== join(root, rel) || !file.startsWith(root + sep)) return false;

  try {
    const st = await stat(file);
    if (!st.isFile()) return false;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // The service worker is what caches; a stale copy here would fight it.
      'Cache-Control': 'no-cache'
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}
