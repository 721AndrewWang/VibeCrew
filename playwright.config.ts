import { defineConfig } from '@playwright/test';

// End-to-end tests: a real Crew server (demo agent) per test, driven through Chrome.
// Uses the installed Google Chrome (CREW_CHROME_PATH to point elsewhere); no browser download.
const chrome = process.env.CREW_CHROME_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    ...(chrome ? { launchOptions: { executablePath: chrome } } : { channel: 'chrome' }),
    trace: 'retain-on-failure',
  },
});
