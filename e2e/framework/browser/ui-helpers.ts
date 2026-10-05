/** Browser UI helpers for Phase 3 Full Matrix E2E. */

import type { Page } from '@playwright/test'

const SHORT = 5_000

export async function uiLogin(
  page: Page,
  uiBase: string,
  username = process.env.GDC_E2E_UI_USERNAME || 'admin',
  password = process.env.GDC_E2E_UI_PASSWORD || 'admin',
): Promise<void> {
  await page.goto(uiBase, { timeout: 15_000, waitUntil: 'domcontentloaded' })
  const user = page.locator('#platform-login-username')
  try {
    await user.waitFor({ state: 'visible', timeout: SHORT })
  } catch {
    // Already authenticated / login form not shown — still handle forced password change.
  }
  if (await user.isVisible().catch(() => false)) {
    await user.fill(username)
    await page.locator('#platform-login-password').fill(password)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await user.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => null)
  }

  // First-install / reset seed may require a password change before SPA routes unlock.
  const changeHeading = page.getByText(/Change your password/i)
  if (await changeHeading.isVisible().catch(() => false)) {
    const nextPassword = process.env.GDC_E2E_UI_PASSWORD || 'Admin123!'
    const current = page.getByLabel(/Current password/i)
    const next = page.getByLabel(/^New password$/i)
    const confirm = page.getByLabel(/Confirm new password/i)
    if (await current.count()) await current.fill(password)
    if (await next.count()) await next.fill(nextPassword)
    if (await confirm.count()) await confirm.fill(nextPassword)
    await page.getByRole('button', { name: /Update password/i }).click()
    await changeHeading.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => null)
    // Sign in again with the new password.
    try {
      await user.waitFor({ state: 'visible', timeout: SHORT })
      await user.fill(username)
      await page.locator('#platform-login-password').fill(nextPassword)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await user.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => null)
    } catch {
      /* already signed in */
    }
  }
  await page.waitForTimeout(400)
}

export async function openConnectorCreate(page: Page, uiBase: string): Promise<void> {
  await page.goto(`${uiBase}/connectors/new`, { timeout: 15_000, waitUntil: 'domcontentloaded' })
  await page.getByText('Create Connector').first().waitFor({ timeout: SHORT }).catch(() => null)
}

export async function selectAuthType(page: Page, authType: string): Promise<void> {
  const sel = page.getByLabel('Authentication Type')
  if (await sel.count()) {
    await sel.selectOption(authType)
  }
}

export async function openStreamWizard(page: Page, uiBase: string): Promise<void> {
  await page.goto(`${uiBase}/streams/new`, { timeout: 15_000, waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="wizard-stepper"], #wizard-stepper').waitFor({ timeout: SHORT }).catch(() => null)
}

export async function openDestinations(page: Page, uiBase: string): Promise<void> {
  await page.goto(`${uiBase}/destinations`, { timeout: 15_000, waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="destinations-new"]').waitFor({ timeout: SHORT }).catch(() => null)
}

export async function openNewDestinationForm(page: Page): Promise<void> {
  const btn = page.locator('[data-testid="destinations-new"]')
  if (await btn.count()) {
    await btn.click()
    await page.locator('[data-testid="destination-form-dialog"]').waitFor({ timeout: SHORT }).catch(() => null)
  }
}

export async function openGovernanceQuarantine(page: Page, uiBase: string): Promise<void> {
  await page.goto(`${uiBase}/governance/quarantine`, { timeout: 15_000, waitUntil: 'domcontentloaded' })
}

export async function openGovernanceReplay(page: Page, uiBase: string): Promise<void> {
  await page.goto(`${uiBase}/governance/replay`, { timeout: 15_000, waitUntil: 'domcontentloaded' })
}

export async function openRuntimeMonitoring(page: Page, uiBase: string): Promise<void> {
  await page.goto(`${uiBase}/monitoring`, { timeout: 15_000, waitUntil: 'domcontentloaded' })
}

export async function assertAuthFieldsVisible(page: Page, authType: string): Promise<string[]> {
  const missing: string[] = []
  const expectations: Record<string, string[]> = {
    basic: ['Basic Username', 'Basic Password'],
    bearer: ['Bearer Token'],
    api_key: ['API Key Name', 'API Key Value'],
    oauth2_client_credentials: ['OAuth Client ID', 'OAuth Client Secret'],
    session_login: ['Session Username', 'Session Password'],
    jwt_refresh_token: ['JWT Refresh Token'],
    vendor_jwt_exchange: ['User ID', 'API Key'],
    no_auth: [],
  }
  for (const label of expectations[authType] || []) {
    if ((await page.getByLabel(label).count()) === 0) missing.push(label)
  }
  return missing
}

/**
 * Exercise Webhook Receiver connector create UI (select type, auth, optional save).
 * Never hangs longer than ~25s total; returns soft failure instead of throwing.
 */
export async function createWebhookReceiverViaUi(
  page: Page,
  uiBase: string,
  opts: {
    name: string
    authMode?: 'no_auth' | 'shared_secret_header' | 'bearer_token'
    sharedSecret?: string
    bearerToken?: string
  },
): Promise<{ connectorId: number | null; saved: boolean; note?: string }> {
  try {
    await openConnectorCreate(page, uiBase)
    await page.getByText('Source type').first().waitFor({ timeout: SHORT })
    // Prefer the labeled radio so React state switches to WEBHOOK_RECEIVER.
    const webhookRadio = page.getByRole('radio', { name: /Webhook Receiver/i })
    try {
      await webhookRadio.waitFor({ state: 'visible', timeout: SHORT })
      await webhookRadio.check({ timeout: SHORT })
    } catch {
      const label = page.locator('label').filter({ hasText: /^Webhook Receiver$/ })
      await label.waitFor({ state: 'visible', timeout: SHORT })
      await label.click({ timeout: SHORT })
    }
    await page.getByRole('heading', { name: 'Webhook Receiver' }).waitFor({ timeout: SHORT }).catch(() => null)

    const nameField = page.getByLabel(/Connector Name/)
    if (await nameField.count({ timeout: SHORT }).catch(() => 0)) {
      await nameField.fill(opts.name, { timeout: SHORT })
    }

    // Default no_auth so Save succeeds without secret validation races.
    const authMode = opts.authMode || 'no_auth'
    const authSelect = page.locator('select').filter({ has: page.locator('option[value="shared_secret_header"]') }).first()
    if (await authSelect.count({ timeout: 2_000 }).catch(() => 0)) {
      await authSelect.selectOption(authMode, { timeout: SHORT }).catch(() => null)
    }
    if (authMode === 'shared_secret_header') {
      const secret = page.getByPlaceholder(/Shared secret/i)
      if (await secret.count({ timeout: 2_000 }).catch(() => 0)) {
        await secret.fill(opts.sharedSecret || 'e2e-ui-webhook-secret', { timeout: SHORT })
      }
    } else if (authMode === 'bearer_token') {
      const token = page.getByPlaceholder(/Bearer token/i)
      if (await token.count({ timeout: 2_000 }).catch(() => 0)) {
        await token.fill(opts.bearerToken || 'e2e-ui-webhook-bearer', { timeout: SHORT })
      }
    }

    const saveBtn = page.getByRole('button', { name: /Save Connector/i }).first()
    if (await saveBtn.count({ timeout: 2_000 }).catch(() => 0)) {
      await saveBtn.click({ timeout: SHORT }).catch(() => null)
      await page.waitForURL(/\/connectors\/\d+/, { timeout: 12_000 }).catch(() => null)
    }
    const m = page.url().match(/\/connectors\/(\d+)/)
    const connectorId = m ? Number(m[1]) : null
    const errBanner = page.locator('p').filter({ hasText: /required|failed|error/i }).first()
    const errText =
      connectorId == null && (await errBanner.count({ timeout: 500 }).catch(() => 0))
        ? await errBanner.textContent().catch(() => null)
        : null
    return { connectorId, saved: connectorId != null, note: errText || undefined }
  } catch (err) {
    return { connectorId: null, saved: false, note: String(err) }
  }
}
