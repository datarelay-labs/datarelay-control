import { chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.resolve(__dirname, '../dashboard-monitoring-screenshot.png')
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:18443'
const username = process.env.PLAYWRIGHT_E2E_USERNAME ?? 'admin'
const password = process.env.PLAYWRIGHT_E2E_PASSWORD ?? ''

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

try {
  await page.goto(`${baseUrl}/monitoring`, { waitUntil: 'domcontentloaded', timeout: 60000 })

  const loginHeading = page.getByRole('heading', { name: 'Welcome to DataRelay' })
  if (await loginHeading.isVisible({ timeout: 5000 }).catch(() => false)) {
    if (!password) throw new Error('PLAYWRIGHT_E2E_PASSWORD is required for login screenshot capture')
    await page.locator('#platform-login-username').fill(username)
    await page.locator('#platform-login-password').fill(password)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await page.waitForURL(/\/(monitoring|streams)/, { timeout: 30000 })
    if (!page.url().includes('/monitoring')) {
      await page.goto(`${baseUrl}/monitoring`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    }
  }

  await page.locator('h1:text-is("Dashboard")').first().waitFor({ state: 'visible', timeout: 30000 })

  const loading = page.getByText(/Loading dashboard data/i)
  if (await loading.isVisible({ timeout: 2000 }).catch(() => false)) {
    await loading.waitFor({ state: 'hidden', timeout: 60000 })
  }

  await page.waitForSelector('[data-testid="dashboard-overall-health-hero"]', { state: 'visible', timeout: 60000 })
  await page.waitForSelector('[data-testid="dashboard-traffic-overview"]', { state: 'visible', timeout: 30000 })
  await page.waitForSelector('[data-testid="dashboard-operational-issues"]', { state: 'visible', timeout: 30000 })
  await page.waitForTimeout(2000)

  await page.screenshot({ path: outPath, fullPage: true })
  console.log(`Screenshot saved: ${outPath}`)
} finally {
  await browser.close()
}
