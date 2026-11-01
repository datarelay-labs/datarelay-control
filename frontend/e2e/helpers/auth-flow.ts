import type { APIRequestContext, Page } from '@playwright/test'

// Centralized env defaults. resolveSmokeAuthEnv() mirrors the helper consumed
// by frontend/scripts/validate-playwright-smoke-env.mjs so preflight output
// and runtime smoke skip reasons stay in sync.
const DEFAULT_USERNAME = 'admin'
const BOOTSTRAP_DEFAULT_PASSWORD = 'admin'

export const E2E_USERNAME = process.env.PLAYWRIGHT_E2E_USERNAME?.trim() || DEFAULT_USERNAME
export const E2E_BOOTSTRAP_PASSWORD =
  process.env.PLAYWRIGHT_E2E_BOOTSTRAP_PASSWORD?.trim() || BOOTSTRAP_DEFAULT_PASSWORD
/** Steady-state operator password (also used as the target when changing the bootstrap password). */
export const E2E_PASSWORD = process.env.PLAYWRIGHT_E2E_PASSWORD?.trim() || ''

const ALLOW_BOOTSTRAP_FALLBACK = (() => {
  const raw = (process.env.PLAYWRIGHT_E2E_ALLOW_BOOTSTRAP_FALLBACK ?? 'true').trim().toLowerCase()
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off'
})()

/**
 * Discriminated probe result. Every "skip-worthy" condition has its own mode so
 * the smoke spec can name it explicitly via formatSkipReason().
 */
export type AuthProbeResult =
  | { mode: 'ready'; password: string; passwordSource: PasswordSource; accessToken: string }
  | {
      mode: 'must_change_password'
      bootstrapPassword: string
      bootstrapAccessToken: string
      steadyPassword: string
      passwordSource: PasswordSource
    }
  | { mode: 'invalid_credentials'; triedUsername: string; triedPasswordSource: PasswordSource; httpStatus: number }
  | { mode: 'api_unreachable'; detail: string }
  | { mode: 'no_credentials' }
  | { mode: 'auth_disabled' }

export type PasswordSource =
  | 'PLAYWRIGHT_E2E_PASSWORD'
  | 'PLAYWRIGHT_E2E_BOOTSTRAP_PASSWORD'
  | 'bootstrap_default(admin/admin)'
  | 'none'

type LoginResponse = {
  access_token?: string
  user?: { must_change_password?: boolean }
  detail?: { message?: string; error_code?: string }
}

type LoginOutcome =
  | { ok: true; body: LoginResponse }
  | { ok: false; kind: 'network'; detail: string }
  | { ok: false; kind: 'rejected'; status: number; body: LoginResponse }

async function apiLogin(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  let res
  try {
    res = await request.post('/api/v1/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username, password }),
      timeout: 8_000,
    })
  } catch (err) {
    return { ok: false, kind: 'network', detail: err instanceof Error ? err.message : String(err) }
  }
  let body: LoginResponse = {}
  try {
    body = (await res.json()) as LoginResponse
  } catch {
    body = {}
  }
  if (res.ok() && typeof body.access_token === 'string' && body.access_token.length > 0) {
    return { ok: true, body }
  }
  return { ok: false, kind: 'rejected', status: res.status(), body }
}

/**
 * Probe the live API and report the authoritative auth state. Each branch is
 * named explicitly so callers can render an actionable skip message.
 *
 * Order of operations:
 *   1. If PLAYWRIGHT_E2E_PASSWORD is set, try it first (steady state).
 *   2. If bootstrap fallback is allowed, try admin/admin (or PLAYWRIGHT_E2E_BOOTSTRAP_PASSWORD).
 *      - If accepted with must_change_password=true and a steady password is set, return
 *        `must_change_password` so the spec can drive the password change UI flow.
 *      - If accepted without must_change_password, return `ready` for direct use.
 *   3. Otherwise classify the failure (network vs rejected) for skip messaging.
 */
export async function probeAuthMode(request: APIRequestContext): Promise<AuthProbeResult> {
  if (E2E_PASSWORD) {
    const steady = await apiLogin(request, E2E_USERNAME, E2E_PASSWORD)
    if (steady.ok) {
      return {
        mode: 'ready',
        password: E2E_PASSWORD,
        passwordSource: 'PLAYWRIGHT_E2E_PASSWORD',
        accessToken: steady.body.access_token!,
      }
    }
    if (steady.kind === 'network') {
      return { mode: 'api_unreachable', detail: steady.detail }
    }
    // steady-password rejected → fall through to bootstrap attempt only when allowed.
    if (!ALLOW_BOOTSTRAP_FALLBACK) {
      return {
        mode: 'invalid_credentials',
        triedUsername: E2E_USERNAME,
        triedPasswordSource: 'PLAYWRIGHT_E2E_PASSWORD',
        httpStatus: steady.status,
      }
    }
  }

  if (!ALLOW_BOOTSTRAP_FALLBACK) {
    if (!E2E_PASSWORD) return { mode: 'no_credentials' }
  }

  const bootstrap = await apiLogin(request, E2E_USERNAME, E2E_BOOTSTRAP_PASSWORD)
  const bootstrapSource: PasswordSource = process.env.PLAYWRIGHT_E2E_BOOTSTRAP_PASSWORD
    ? 'PLAYWRIGHT_E2E_BOOTSTRAP_PASSWORD'
    : 'bootstrap_default(admin/admin)'

  if (bootstrap.ok) {
    const mustChange = bootstrap.body.user?.must_change_password === true
    if (!mustChange) {
      return {
        mode: 'ready',
        password: E2E_BOOTSTRAP_PASSWORD,
        passwordSource: bootstrapSource,
        accessToken: bootstrap.body.access_token!,
      }
    }
    if (E2E_PASSWORD) {
      return {
        mode: 'must_change_password',
        bootstrapPassword: E2E_BOOTSTRAP_PASSWORD,
        bootstrapAccessToken: bootstrap.body.access_token!,
        steadyPassword: E2E_PASSWORD,
        passwordSource: bootstrapSource,
      }
    }
    return { mode: 'must_change_password', bootstrapPassword: E2E_BOOTSTRAP_PASSWORD, bootstrapAccessToken: bootstrap.body.access_token!, steadyPassword: '', passwordSource: bootstrapSource }
  }

  if (bootstrap.kind === 'network') {
    return { mode: 'api_unreachable', detail: bootstrap.detail }
  }
  return {
    mode: 'invalid_credentials',
    triedUsername: E2E_USERNAME,
    triedPasswordSource: bootstrapSource,
    httpStatus: bootstrap.status,
  }
}

/** Single source of truth for "why did Playwright smoke skip?". */
export function formatProbeSkipReason(probe: AuthProbeResult): string {
  switch (probe.mode) {
    case 'api_unreachable':
      return (
        `Playwright smoke skipped: API unreachable (${probe.detail}). ` +
        'Start the dev platform (./scripts/dev/bootstrap-dev-platform.sh) before retrying.'
      )
    case 'invalid_credentials':
      return (
        `Playwright smoke skipped: API rejected login for username "${probe.triedUsername}" ` +
        `(password source: ${probe.triedPasswordSource}; HTTP ${probe.httpStatus}). ` +
        'Set PLAYWRIGHT_E2E_USERNAME / PLAYWRIGHT_E2E_PASSWORD to operator credentials, ' +
        'or run scripts/admin/reset-admin-password.sh to align the admin password.'
      )
    case 'must_change_password':
      if (!probe.steadyPassword) {
        return (
          'Playwright smoke skipped: bootstrap login succeeded but must_change_password=true ' +
          'and PLAYWRIGHT_E2E_PASSWORD is not set. ' +
          'Export PLAYWRIGHT_E2E_PASSWORD=<steady password> and rerun; the spec will perform the ' +
          'password change automatically.'
        )
      }
      return 'Playwright smoke skipped: must_change_password but spec did not run change flow (unexpected).'
    case 'no_credentials':
      return (
        'Playwright smoke skipped: PLAYWRIGHT_E2E_PASSWORD unset and PLAYWRIGHT_E2E_ALLOW_BOOTSTRAP_FALLBACK=false. ' +
        'Set PLAYWRIGHT_E2E_PASSWORD or re-enable the bootstrap admin/admin fallback.'
      )
    case 'auth_disabled':
      return (
        'Playwright smoke skipped: API does not require auth. ' +
        'Restart the API with REQUIRE_AUTH=true; the smoke suite expects authenticated access.'
      )
    default:
      return 'Playwright smoke skipped: unknown auth probe state.'
  }
}

/** Password to use after the initial sign-in flow completes (for re-login after change-password). */
export function sessionPassword(probe: AuthProbeResult): string {
  if (probe.mode === 'ready') return probe.password
  if (probe.mode === 'must_change_password') return probe.steadyPassword || probe.bootstrapPassword
  return ''
}

export async function clearClientSession(page: Page): Promise<void> {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.removeItem('gdc_platform_session_v1')
    localStorage.removeItem('gdc_platform_ui_role')
    localStorage.removeItem('gdc_platform_ui_username')
  })
}

/**
 * Open an in-app path right after a UI sign-in.  The SPA drops its stored
 * session when its boot-time whoami request is aborted, and a hard navigation
 * while the first page is still loading aborts it, so let the page settle first.
 */
export async function gotoAfterLogin(page: Page, path: string): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  await page.goto(path)
}

export async function expectLoginScreen(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Welcome to DataRelay' }).waitFor({ state: 'visible' })
}

export async function uiLogin(page: Page, username: string, password: string): Promise<void> {
  await expectLoginScreen(page)
  await page.locator('#platform-login-username').fill(username)
  await page.locator('#platform-login-password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
}

export async function uiChangeDefaultPassword(
  page: Page,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await page.getByRole('heading', { name: /Change (your|default) password/i }).waitFor({ state: 'visible' })
  await page.locator('#force-pw-current').fill(currentPassword)
  await page.locator('#force-pw-new').fill(newPassword)
  await page.locator('#force-pw-confirm').fill(newPassword)
  await page.getByRole('button', { name: 'Update password and sign in again' }).click()
  await expectLoginScreen(page)
}

/**
 * High-level sign-in for the smoke spec: handles both "steady" and
 * "must_change_password" probe modes uniformly.
 */
export async function signInForSmoke(page: Page, probe: AuthProbeResult): Promise<void> {
  if (probe.mode === 'ready') {
    await page.goto('/')
    await uiLogin(page, E2E_USERNAME, probe.password)
    return
  }
  if (probe.mode === 'must_change_password') {
    await page.goto('/')
    await uiLogin(page, E2E_USERNAME, probe.bootstrapPassword)
    if (!probe.steadyPassword) {
      throw new Error(
        'signInForSmoke: bootstrap login required a password change but no steady password was supplied. ' +
          'This is a smoke-spec contract violation — the spec must skip via formatProbeSkipReason() instead.',
      )
    }
    await uiChangeDefaultPassword(page, probe.bootstrapPassword, probe.steadyPassword)
    await uiLogin(page, E2E_USERNAME, probe.steadyPassword)
    return
  }
  throw new Error(`signInForSmoke: unsupported probe.mode=${probe.mode}; call formatProbeSkipReason() and skip instead.`)
}

export async function expectDashboard(page: Page): Promise<void> {
  await page.getByRole('heading', { level: 2, name: 'Operations Center' }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByText('Active Streams').waitFor({ state: 'visible' })
}

export async function expectAppShell(page: Page): Promise<void> {
  const nav = page.getByRole('complementary', { name: 'Primary navigation' })
  await nav.waitFor({ state: 'visible' })
  const homeNav = nav
    .getByRole('button', { name: 'Dashboard' })
    .or(nav.getByRole('button', { name: 'Monitoring' }))
  await homeNav.first().waitFor({ state: 'visible', timeout: 20_000 })
  await nav.getByRole('button', { name: 'Streams' }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByText(E2E_USERNAME, { exact: true }).waitFor({ state: 'visible' })
}

export async function openRuntimePage(page: Page): Promise<void> {
  const nav = page.getByRole('complementary', { name: 'Primary navigation' })
  await nav.getByRole('button', { name: 'Runtime' }).click()
  await page.getByRole('heading', { level: 1, name: 'Runtime' }).waitFor({ state: 'visible' })
  await page.getByRole('heading', { name: 'Streams' }).waitFor({ state: 'visible' })
}

export async function readAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('gdc_platform_session_v1')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { access_token?: string }
      return typeof parsed.access_token === 'string' ? parsed.access_token : null
    } catch {
      return null
    }
  })
  if (!token) throw new Error('Expected JWT in gdc_platform_session_v1 after login')
  return token
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expectLoginScreen(page)
}
