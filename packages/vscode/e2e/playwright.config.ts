import { defineConfig } from '@playwright/test';

// End-to-end scenarios: each test drives a fresh VS Code with the extension
// loaded and compares its checkpoints against e2e/approved/<spec>/<test>.md.
// Approve new or intended output with `npm run test:e2e -- --update-snapshots`.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: '../e2e-results/artifacts',
  snapshotPathTemplate: '{testDir}/approved/{testFileName}/{arg}{ext}',
  // Per test, and for the whole run on CI so a hang can't burn runner minutes.
  timeout: 90_000,
  globalTimeout: process.env.CI ? 10 * 60_000 : 0,
  expect: { timeout: 10_000 },
  // Instances are fully isolated, but one window at a time keeps keyboard
  // focus and timing predictable.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['json', { outputFile: '../e2e-results/summary.json' }],
    ['junit', { outputFile: '../e2e-results/junit.xml' }],
    ['html', { outputFolder: '../e2e-results/html', open: 'never' }],
  ],
});
