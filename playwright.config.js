const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.PORT || 8117);
const SYNC_PORT = Number(process.env.SYNC_PORT || PORT + 1);

module.exports = defineConfig({
  testDir: './tests',
  // The suites drive one page through a whole session, so they are serial by
  // design. Several also write to index.html/sw.js, which cannot overlap.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [{
    name: 'chromium',
    use: {
      browserName: 'chromium',
      // CI installs its own browser. CHROMIUM_PATH is for sandboxes that ship
      // a preinstalled Chromium and cannot download one.
      launchOptions: process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}
    }
  }, {
    // The engine the app is actually used on. Chromium has no on-screen
    // keyboard, no gesturestart, honours user-scalable, and reports zero for
    // every safe-area inset — so every iOS behaviour the app handles was
    // invisible to the suite, and several were found on a phone instead.
    //
    // Not the same as Safari, and not the same as iOS Safari: shared engine,
    // different shell. No real keyboard, no Home Screen lifecycle. It closes
    // most of the gap rather than all of it.
    name: 'webkit',
    use: { browserName: 'webkit' },
    // The service-worker suite stays on Chromium. Playwright's WebKit does not
    // drive registration, update and offline emulation reliably enough to
    // assert on, and what it would be testing is Playwright's WebKit rather
    // than Safari's service worker, which is a different implementation again.
    testIgnore: /pwa\.spec\.js/
  }],
  webServer: [{
    command: `node tests/server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }, {
    // The real sync server, serving the app from its own origin — which is how
    // it is meant to be deployed, and the only way to exercise the client
    // against something that actually enforces the clocks.
    //
    // In memory, so every run starts empty; registration is open, because
    // minting an invite per test would be testing the invite rather than the
    // sync.
    command: 'node server/src/index.js',
    url: `http://127.0.0.1:${SYNC_PORT}/healthz`,
    env: {
      LOGBOOK_PORT: String(SYNC_PORT),
      LOGBOOK_DB: ':memory:',
      LOGBOOK_OPEN_REGISTRATION: 'true',
      LOGBOOK_SERVE_STATIC: 'true',
      // Every simulated phone here shares one address, and the real limits are
      // five unlocks an hour. Raised rather than removed: the limiter still
      // runs, and its own tests are in the server suite where they can hold it
      // to something tight.
      LOGBOOK_LIMIT_UNLOCK_PER_HOUR: '100000',
      LOGBOOK_LIMIT_CREATE_PER_HOUR: '100000',
      LOGBOOK_LIMIT_WRITE_PER_MIN: '100000'
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }]
});
