import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(process.env.QA_RUN_DIR || path.join(root, 'reports/e2e'));

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['json', { outputFile: path.join(reportDir, 'browser.json') }]],
  outputDir: path.join(reportDir, 'browser-artifacts'),
  use: {
    baseURL: 'http://127.0.0.1:4190',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node ../local/server.mjs',
    cwd: root,
    url: 'http://127.0.0.1:4190/',
    env: { TUTOR_PROVIDER: 'off', TUTOR_PORT: '4190' },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
