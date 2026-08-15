const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.PORT || 8117);

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
  }],
  webServer: {
    command: `node tests/server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
