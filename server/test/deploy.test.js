import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_FILE } from '../src/http.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(join(repo, p), 'utf8');
// Comments stripped, for the assertions that check something is *absent*: the
// manifests explain what they are not doing and why, and a comment saying
// "ReadWriteMany would be wrong here" should not read as ReadWriteMany.
const code = p => read(p).split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

// No kustomize or compose binary in this suite, and no YAML parser either — the
// server has no dependencies and is not about to grow one for this. What is
// asserted instead is the handful of lines whose absence breaks something
// quietly, each of which is a decision rather than a default.
describe('what the deployment must not lose', () => {
  test('one replica everywhere, because the database is SQLite', () => {
    const k8s = read('deploy/k8s/base/deployment.yaml');
    const swarm = read('deploy/stack.yml');
    // Two writers over one file corrupt it, and two schedulers send every
    // notification twice. This is the rule the whole deployment is shaped by.
    assert.match(k8s, /^\s*replicas: 1$/m);
    assert.match(swarm, /^\s*replicas: 1$/m);
  });

  test('neither target starts the new one before stopping the old', () => {
    // Kubernetes defaults to RollingUpdate and Swarm to start-first. Both run
    // two processes at once for a moment, and a moment is all it takes.
    assert.match(read('deploy/k8s/base/deployment.yaml'), /^\s*type: Recreate$/m);
    const swarm = read('deploy/stack.yml');
    assert.equal((swarm.match(/^\s*order: stop-first$/gm) || []).length, 2,
      'update_config and rollback_config both');
  });

  test('the volume is claimed by one writer', () => {
    assert.match(code('deploy/k8s/base/pvc.yaml'), /ReadWriteOnce/);
    assert.doesNotMatch(code('deploy/k8s/base/pvc.yaml'), /ReadWriteMany/);
  });

  test('the container gives itself nothing it does not need', () => {
    const k8s = read('deploy/k8s/base/deployment.yaml');
    for (const line of [/runAsNonRoot: true/, /readOnlyRootFilesystem: true/,
                        /allowPrivilegeEscalation: false/, /drop: \["ALL"\]/,
                        // Without fsGroup the mounted volume is not writable by
                        // the image's user, and the pod crash-loops on first start.
                        /fsGroup: 1000/]) {
      assert.match(k8s, line, String(line));
    }
    const compose = read('deploy/compose.yml');
    assert.match(compose, /read_only: true/);
    assert.match(compose, /no-new-privileges:true/);
  });

  test('the private half of the key is a file, not an environment variable', () => {
    // One `docker inspect`, or one `kubectl get pod -o yaml`, away otherwise.
    assert.match(read('deploy/stack.yml'), /LOGBOOK_VAPID_PRIVATE_FILE/);
    assert.match(read('deploy/k8s/base/deployment.yaml'), /LOGBOOK_VAPID_PRIVATE_FILE/);
  });

  test('the image ships every file the server is willing to serve', () => {
    // The static handler serves an allowlist. If a file is added to that list
    // and not to the image, the container answers 404 for something the service
    // worker precaches — which breaks offline launch and nothing else, so it
    // would be found by a user rather than here.
    const dockerfile = read('server/Dockerfile');
    const candidates = [
      ...readdirSync(repo),
      ...readdirSync(join(repo, 'img')).map(f => `img/${f}`)
    ];
    const served = candidates.filter(f => APP_FILE.some(re => re.test(f)));
    assert.ok(served.length > 40, `the allowlist matched ${served.length} files`);

    for (const f of served) {
      const copied = dockerfile.includes(f)
        || (f.startsWith('img/') && /^COPY img\/ /m.test(dockerfile));
      assert.ok(copied, `${f} is served but not copied into the image`);
    }
  });

  test('the static deployment ships the same app the image does', async () => {
    // Vercel, left alone, publishes the whole repository at the app's own
    // domain. The build borrows the server's allowlist so that three things —
    // the image, the static host, and what the service worker precaches —
    // cannot disagree about what "the app" is.
    const vercel = JSON.parse(read('vercel.json'));
    assert.equal(vercel.outputDirectory, 'dist');
    assert.match(vercel.buildCommand, /deploy\/vercel-build\.mjs/);
    assert.match(read('deploy/vercel-build.mjs'), /import \{ APP_FILE \}/);
    // The worker is the one file that must never be served stale: a cached one
    // is an app that cannot be updated.
    const sw = vercel.headers.find(h => h.source === '/sw.js');
    assert.ok(sw, 'sw.js has its own cache header');
    assert.match(sw.headers[0].value, /max-age=0/);
    assert.ok(read('.gitignore').split('\n').includes('dist/'), 'the build output is not committed');
  });

  test('the image does not ship what the repository keeps to itself', () => {
    const ignore = read('.dockerignore');
    for (const path of ['.git', 'tests', 'server/test', 'node_modules']) {
      assert.ok(ignore.split('\n').includes(path), `${path} is ignored`);
    }
  });

  test('the healthcheck asks the endpoint that opens the database', () => {
    // /healthz says the process is up; /readyz says it can reach its disk. A
    // pod whose volume is not writable should fail readiness rather than take
    // traffic and fail every write.
    const k8s = read('deploy/k8s/base/deployment.yaml');
    assert.match(k8s, /readinessProbe:[\s\S]*?path: \/readyz/);
    assert.match(k8s, /livenessProbe:[\s\S]*?path: \/healthz/);
  });
});
