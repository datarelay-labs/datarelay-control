import { defineConfig, devices } from '@playwright/test'

/**
 * Isolated, test-only visual acceptance. Serves the real dashboard component,
 * not an authenticated product surface, on a loopback Vite instance.
 */
export default defineConfig({
  testDir: './e2e/visual',
  testMatch: 'routing-flow.spec.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:19789',
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 19789 --strictPort',
    url: 'http://127.0.0.1:19789/e2e/fixtures/routing-flow-visual.html',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
