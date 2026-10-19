import { defineConfig, devices } from '@playwright/test'

/**
 * The runner for the browser journeys, which live under `journeys/` (the J2
 * happy path and the agent probe add them). The contract checks drive Chromium
 * directly from `src/checks/` and do not go through this runner.
 */
export default defineConfig({
  testDir: 'journeys',
  outputDir: 'test-results',
  // A flaky journey is worse than none: a failure is reported, never retried
  // into a pass.
  retries: 0,
  // Every journey signs in as the one standing test user.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    headless: true,
    // Traces, screenshots and videos capture what is typed, the test user's
    // password included, and CI uploads test-results/. A journey that needs
    // one turns it on for a step that types nothing secret.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
