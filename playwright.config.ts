import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // tools/ holds the screenshot capture used for design review (pnpm screenshots).
  testIgnore: process.env.SCREENSHOTS ? [] : ['**/tools/**'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
