// Playwright configuration for the dashboard's browser tests (UI-T01): `e2e` runs behaviour and accessibility checks
// (*.e2e.ts), `visual` compares screenshots (*.visual.ts). Both run against a production build of the app and the
// component catalogue (`node test/tooling/build.ts --e2e`), served by serve.ts on 127.0.0.1 with the production CSP.
// Browser: DASHBOARD_CHROMIUM names a Chromium executable (local: /opt/pw-browsers/chromium); DASHBOARD_BROWSER_CHANNEL
// names an installed channel (CI: chrome, preinstalled on the GitHub runner); otherwise Playwright's own Chromium.
import { defineConfig, type LaunchOptions } from '@playwright/test';

const PORT = 4317;
const executablePath = process.env['DASHBOARD_CHROMIUM'];
const channel = process.env['DASHBOARD_BROWSER_CHANNEL'];
const launchOptions: LaunchOptions = executablePath !== undefined && executablePath !== '' ? { executablePath } : {};

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  forbidOnly: true,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  // Strict: any pixel beyond Playwright's per-pixel colour threshold fails (a two-word font change must not pass).
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0, threshold: 0.2 } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    ...(channel !== undefined && channel !== '' ? { channel } : {}),
    launchOptions,
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  webServer: {
    command: `node test/tooling/serve.ts --preview --dir .e2e-build --port ${PORT}`,
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    { name: 'e2e', testMatch: /.*\.e2e\.ts$/ },
    { name: 'visual', testMatch: /.*\.visual\.ts$/ },
  ],
});
