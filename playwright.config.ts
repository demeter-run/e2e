import { defineConfig, devices } from '@playwright/test'

/**
 * The runner for the browser journeys under `journeys/`, which `pnpm journey`
 * starts (`src/cli/journeys.ts`). The contract checks drive Chromium directly
 * from `src/checks/` and do not go through this runner.
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
    // Under the runner an action waits with no limit by default, so a click
    // whose element never becomes clickable, or whose page never loads, would
    // hold its step until the test's timeout and leave nothing said of it.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    // Traces, screenshots and videos capture what is typed, the test user's
    // password included, and traces the session cookie and the port's key
    // too; CI uploads results/. A journey's failed step takes its own
    // screenshot with the secrets masked (`src/journeys/browser.ts`).
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
