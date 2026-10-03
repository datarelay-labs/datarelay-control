import type { Browser, Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import type { ArtifactStore } from './artifacts.js'
import type { ApiClient } from './api.js'
import { captureBrowserCensus } from './browser-census.js'

type RoleUser = {
  username: string
  credential: string
  role: 'OPERATOR' | 'VIEWER'
}

function roleUsers(runId: string) {
  return {
    forced: {
      username: `e2e-${runId}-forced`,
      credential: `Tmp-${runId}-A1!`,
      role: 'VIEWER' as const,
    },
    operator: {
      username: `e2e-${runId}-operator`,
      credential: `Role-${runId}-Op1!`,
      role: 'OPERATOR' as const,
    },
    viewer: {
      username: `e2e-${runId}-viewer`,
      credential: `Role-${runId}-Vw1!`,
      role: 'VIEWER' as const,
    },
  }
}
async function seedUser(api: ApiClient, user: RoleUser): Promise<number> {
  const created = await api.request('POST', '/api/v1/admin/users', {
    username: user.username,
    password: user.credential,
    role: user.role,
  })
  if (created.status >= 300 || !created.json?.id) {
    throw new Error(`unable to create ${user.role} fixture user: ${created.status}`)
  }
  return Number(created.json.id)
}

async function login(page: Page, uiBase: string, user: RoleUser, expectAppShell = true): Promise<void> {
  await page.goto(uiBase, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.locator('#platform-login-username').fill(user.username)
  await page.locator('#platform-login-password').fill(user.credential)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.locator('#platform-login-username').waitFor({ state: 'hidden', timeout: 10_000 })
  if (expectAppShell) {
    await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20_000 })
  }
}

async function deleteUser(api: ApiClient, id: number): Promise<void> {
  await api.request('DELETE', `/api/v1/admin/users/${id}`).catch(() => null)
}

async function safeSessionDiagnostic(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    let role: string | null = null
    let username: string | null = null
    let mustChange = false
    try {
      const raw = localStorage.getItem('gdc_platform_session_v1')
      const parsed = raw ? JSON.parse(raw) : null
      role = typeof parsed?.user?.role === 'string' ? parsed.user.role : null
      username = typeof parsed?.user?.username === 'string' ? parsed.user.username : null
      mustChange = parsed?.user?.must_change_password === true
    } catch {
      // Diagnostic only.
    }
    return {
      role,
      username,
      mustChange,
      url: window.location.href,
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    }
  })
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err).slice(0, 500)}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text().slice(0, 500)}`)
  })
  return errors
}
export async function runFirstLoginAndRbacLifecycle(opts: {
  browser: Browser
  adminPage: Page
  api: ApiClient
  store: ArtifactStore
  runId: string
  uiBase: string
  fixtureScript: string
}): Promise<void> {
  const { browser, adminPage, api, store, runId, uiBase, fixtureScript } = opts
  const users = roleUsers(runId)
  const ids: number[] = []

  try {
    for (const user of [users.forced, users.operator, users.viewer]) {
      ids.push(await seedUser(api, user))
    }

    const mark = spawnSync('python3', [fixtureScript, 'mark-password-change', '--username', users.forced.username], {
      env: process.env,
      encoding: 'utf8',
    })
    if (mark.status !== 0) {
      const detail = String(mark.stderr || mark.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 280)
      throw new Error(`failed to mark first-login fixture${detail ? `: ${detail}` : ''}`)
    }

    const forcedContext = await browser.newContext()
    const forcedPage = await forcedContext.newPage()
    await login(forcedPage, uiBase, users.forced, false)
    const gate = forcedPage.getByRole('heading', { name: /Change your password/i })
    await gate.waitFor({ timeout: 10_000 })
    const changed = `Changed-${runId}-A1!`
    await forcedPage.getByLabel(/Current password/i).fill(users.forced.credential)
    await forcedPage.getByLabel(/^New password$/i).fill(changed)
    await forcedPage.getByLabel(/Confirm new password/i).fill(changed)
    await forcedPage.getByRole('button', { name: /Update password and sign in again/i }).click()
    await forcedPage.waitForTimeout(700)
    const forcedError = await forcedPage.getByRole('alert').innerText().catch(() => '')
    let forcedPass = false
    if (await forcedPage.locator('#platform-login-username').isVisible().catch(() => false)) {
      await forcedPage.locator('#platform-login-username').fill(users.forced.username)
      await forcedPage.locator('#platform-login-password').fill(changed)
      await forcedPage.getByRole('button', { name: 'Sign In' }).click()
      const loginHidden = await forcedPage
        .locator('#platform-login-username')
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      const appShellVisible =
        loginHidden &&
        (await forcedPage
          .locator('#main-content')
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => true)
          .catch(() => false))
      forcedPass = loginHidden && appShellVisible && !(await gate.isVisible().catch(() => false))
    }
    store.rec(
      'BFS001_FIRST_LOGIN_PASSWORD_CHANGE',
      forcedPass ? 'PASS' : 'FAIL',
      `gateVisibleInitially=true changed=${forcedPass} errorVisible=${Boolean(forcedError)}`,
      ['BROWSER_E2E'],
    )
    await forcedContext.close()

    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    const viewerErrors = captureBrowserErrors(viewerPage)
    await login(viewerPage, uiBase, users.viewer)
    const viewerAfterLogin = await safeSessionDiagnostic(viewerPage)
    await viewerPage.goto(`${uiBase}/admin`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await viewerPage.waitForTimeout(500)
    const viewerAfterAdmin = await safeSessionDiagnostic(viewerPage)
    const viewerAdminText = await viewerPage.locator('body').innerText()
    await viewerPage.goto(`${uiBase}/settings`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await viewerPage.waitForTimeout(500)
    const viewerAfterSettings = await safeSessionDiagnostic(viewerPage)
    const viewerSettings = viewerPage.getByTestId('admin-settings-page')
    const viewerSettingsVisible = await viewerSettings.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)
    const viewerReadonlyBanner = await viewerPage
      .getByTestId('admin-settings-readonly-banner')
      .isVisible()
      .catch(() => false)
    await captureBrowserCensus(viewerPage, store, '/settings', 'READ_ONLY_RBAC')
    const viewerCreate = viewerPage.getByTestId('admin-users-create')
    const viewerCreatePresent = (await viewerCreate.count()) > 0
    const viewerCreateVisible = viewerCreatePresent && (await viewerCreate.isVisible().catch(() => false))
    const viewerCreateDisabled = viewerCreatePresent && (await viewerCreate.isDisabled().catch(() => false))
    const governanceHidden = (await viewerPage.getByRole('button', { name: 'Governance Workspace' }).count()) === 0
    const viewerPass =
      /Viewer session.*read-only/i.test(viewerAdminText) &&
      viewerSettingsVisible &&
      viewerReadonlyBanner &&
      viewerCreatePresent &&
      viewerCreateVisible &&
      viewerCreateDisabled &&
      governanceHidden
    store.writeJson('rbac-viewer-diagnostic.json', {
      afterLogin: viewerAfterLogin,
      afterAdmin: viewerAfterAdmin,
      afterSettings: viewerAfterSettings,
      browserErrors: viewerErrors,
    })
    store.rec(
      'BFS016_RBAC_VIEWER',
      viewerPass ? 'PASS' : 'FAIL',
      `hubReadOnly=${/Viewer session.*read-only/i.test(viewerAdminText)} settings=${viewerSettingsVisible} readonlyBanner=${viewerReadonlyBanner} createPresent=${viewerCreatePresent} createVisible=${viewerCreateVisible} createDisabled=${viewerCreateDisabled} governanceHidden=${governanceHidden} url=${viewerPage.url()}`,
      ['BROWSER_E2E'],
    )
    await viewerContext.close()
    const operatorContext = await browser.newContext()
    const operatorPage = await operatorContext.newPage()
    const operatorErrors = captureBrowserErrors(operatorPage)
    await login(operatorPage, uiBase, users.operator)
    const operatorAfterLogin = await safeSessionDiagnostic(operatorPage)
    await operatorPage.goto(`${uiBase}/admin`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await operatorPage.waitForTimeout(500)
    const operatorAfterAdmin = await safeSessionDiagnostic(operatorPage)
    const operatorAdminText = await operatorPage.locator('body').innerText()
    await operatorPage.goto(`${uiBase}/settings`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await operatorPage.waitForTimeout(500)
    const operatorAfterSettings = await safeSessionDiagnostic(operatorPage)
    const operatorSettingsVisible = await operatorPage
      .getByTestId('admin-settings-page')
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    const operatorBanner = operatorPage.getByTestId('admin-settings-operator-banner')
    const operatorBannerVisible = await operatorBanner.isVisible().catch(() => false)
    const operatorCreate = operatorPage.getByTestId('admin-users-create')
    const operatorHttps = operatorPage.getByTestId('admin-https-save')
    const operatorCreatePresent = (await operatorCreate.count()) > 0
    const operatorHttpsPresent = (await operatorHttps.count()) > 0
    const operatorCreateDisabled = operatorCreatePresent && (await operatorCreate.isDisabled().catch(() => false))
    const operatorHttpsDisabled = operatorHttpsPresent && (await operatorHttps.isDisabled().catch(() => false))
    const operatorPass =
      /Operator session/i.test(operatorAdminText) &&
      operatorSettingsVisible &&
      operatorBannerVisible &&
      operatorCreateDisabled &&
      operatorHttpsDisabled
    store.writeJson('rbac-operator-diagnostic.json', {
      afterLogin: operatorAfterLogin,
      afterAdmin: operatorAfterAdmin,
      afterSettings: operatorAfterSettings,
      browserErrors: operatorErrors,
    })
    store.rec(
      'BFS016_RBAC_OPERATOR',
      operatorPass ? 'PASS' : 'FAIL',
      `hubOperator=${/Operator session/i.test(operatorAdminText)} settings=${operatorSettingsVisible} banner=${operatorBannerVisible} createPresent=${operatorCreatePresent} createDisabled=${operatorCreateDisabled} httpsPresent=${operatorHttpsPresent} httpsDisabled=${operatorHttpsDisabled} url=${operatorPage.url()}`,
      ['BROWSER_E2E'],
    )
    await operatorContext.close()

    await adminPage.goto(`${uiBase}/settings`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    const adminSettingsVisible = await adminPage
      .getByTestId('admin-settings-page')
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    const adminCreate = adminPage.getByTestId('admin-users-create')
    const adminCreatePresent = (await adminCreate.count()) > 0
    const adminCreateEnabled = adminCreatePresent && !(await adminCreate.isDisabled().catch(() => true))
    await captureBrowserCensus(adminPage, store, '/settings', 'MUTATING_RBAC')
    store.rec(
      'BFS016_RBAC_ADMINISTRATOR',
      adminSettingsVisible && adminCreateEnabled ? 'PASS' : 'FAIL',
      `settings=${adminSettingsVisible} createPresent=${adminCreatePresent} createEnabled=${adminCreateEnabled} url=${adminPage.url()}`,
      ['BROWSER_E2E'],
    )
  } finally {
    for (const id of ids.reverse()) await deleteUser(api, id)
  }
}
