// What Vercel serves.
//
// Left alone, a static deployment of this repository publishes the whole of it
// at the app's own domain: the server's source, the test suite, the docs, the
// package manifest. None of that is secret — the repository is public — but the
// app is the app, and the definition of it already exists in one place.
//
// So this borrows the same allowlist the server's static handler uses, which is
// itself the list the service worker precaches. Three things that have to agree
// about what "the app" means, and one place that says it.
import { APP_FILE } from '../server/src/http.js';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'dist');

const candidates = [
  ...readdirSync(repo),
  ...readdirSync(join(repo, 'img')).map(f => `img/${f}`)
];
const app = candidates.filter(f => APP_FILE.some(re => re.test(f)));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'img'), { recursive: true });
for (const f of app) cpSync(join(repo, f), join(out, f));

const bytes = app.reduce((n, f) => n + statSync(join(out, f)).size, 0);
console.log(`${app.length} files, ${(bytes / 1024).toFixed(0)} KB`);
// A deployment with no index.html is a 404 that took a minute to build.
if (!app.includes('index.html')) {
  console.error('index.html is not in the allowlist — nothing would be served');
  process.exit(1);
}
