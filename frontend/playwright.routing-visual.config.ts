import { defineConfig, devices } from '@playwright/test'

/** A run-specific isolated port prevents recycling another PR's Vite bundle. */
const visualPort = process.env.CONTROL_ROUTING_VISUAL_PORT ?? '19789'

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
    baseURL: 'http://127.0.0.1:' + visualPort,
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port ' + visualPort + ' --strictPort',
    url: 'http://127.0.0.1:' + visualPort + '/e2e/fixtures/routing-flow-visual.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
