import { defineConfig } from '@playwright/test';

// The packaged desktop app (release/linux-unpacked). Run `npm run desktop:pack` first.
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
});
