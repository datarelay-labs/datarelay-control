import { defineConfig, devices } from '@playwright/test'

// Account / governance real-browser specs (F-192, F-187, F-202) plus the operator-auth smoke.
// Everything is environment driven so the suite can run against a disposable stack on its own ports:
//   PLAYWRIGHT_API_BASE_URL  API under test (REQUIRE_AUTH=true)
//   PLAYWRIGHT_BASE_URL      UI origin Playwright starts (vite dev server proxying /api to the API)
//   PLAYWRIGHT_E2E_USERNAME / PLAYWRIGHT_E2E_PASSWORD   administrator of that disposable stack
//   PLAYWRIGHT_OUTPUT_DIR    where traces / artifacts go (keep it outside the repository)
const apiProxyTarget = process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://127.0.0.1:8000'
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173'
const uiPort = new URL(baseURL).port || '4173'

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'forced-password-change.spec.ts',
    'policy-separation-of-duties.spec.ts',
    'display-settings-rbac.spec.ts',
    'operator-auth-runtime-smoke.spec.ts',
  ],
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${uiPort} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      VITE_DEV_API_PROXY_TARGET: apiProxyTarget,
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
