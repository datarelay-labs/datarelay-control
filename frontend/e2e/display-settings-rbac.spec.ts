import { expect, test } from '@playwright/test'
import { clearClientSession, gotoAfterLogin, uiLogin } from './helpers/auth-flow'
import {
  MISSING_ADMIN_CREDENTIALS_REASON,
  adminToken,
  bearer,
  completeForcedChange,
  createAccount,
  deleteAccount,
  hasAdminCredentials,
  login,
} from './helpers/admin-api'

// F-192: the platform-wide default timezone (display settings) is Administrator-only to write.
test.describe.configure({ mode: 'serial' })
test.skip(!hasAdminCredentials, MISSING_ADMIN_CREDENTIALS_REASON)

test('an Operator is denied display-settings writes in the UI and the API, an Administrator is not', async ({
  page,
  request,
}) => {
  const admin = await adminToken(request)
  const before = await request.get('/api/v1/admin/display-settings', { headers: bearer(admin) })
  expect(before.status()).toBe(200)
  const originalTimezone = String((await before.json()).default_timezone)
  const wanted = originalTimezone === 'Asia/Seoul' ? 'Asia/Tokyo' : 'Asia/Seoul'

  const operator = await createAccount(request, admin, 'OPERATOR', 'tzop')
  try {
    await completeForcedChange(request, operator)
    const session = await login(request, operator.username, operator.password)
    expect(session.status).toBe(200)
    const operatorToken = String(session.body?.access_token)

    await clearClientSession(page)
    await uiLogin(page, operator.username, operator.password)
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })
    await gotoAfterLogin(page, '/settings')
    const panel = page.getByTestId('admin-display-timezone-panel')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('admin-display-timezone-save-platform')).toBeDisabled()
    await expect(page.getByTestId('admin-display-timezone-platform-locked')).toBeVisible()

    // The backend refuses the write even when the UI is bypassed; the platform default is untouched.
    const denied = await request.put('/api/v1/admin/display-settings', {
      headers: bearer(operatorToken),
      data: { default_timezone: wanted },
    })
    expect(denied.status()).toBe(403)
    expect((await denied.json()).detail.error_code).toBe('ROLE_FORBIDDEN')
    const unchanged = await request.get('/api/v1/admin/display-settings', { headers: bearer(admin) })
    expect((await unchanged.json()).default_timezone).toBe(originalTimezone)

    // Reading stays available, and a personal timezone preference is still the operator's own to set.
    const read = await request.get('/api/v1/admin/display-settings', { headers: bearer(operatorToken) })
    expect(read.status()).toBe(200)
    const personal = await request.patch('/api/v1/auth/profile', {
      headers: bearer(operatorToken),
      data: { timezone: wanted },
    })
    expect(personal.status()).toBe(200)

    // The Administrator can write it (and the test restores the original value).
    const allowed = await request.put('/api/v1/admin/display-settings', {
      headers: bearer(admin),
      data: { default_timezone: wanted },
    })
    expect(allowed.status()).toBe(200)
    expect((await allowed.json()).default_timezone).toBe(wanted)
  } finally {
    await request
      .put('/api/v1/admin/display-settings', { headers: bearer(admin), data: { default_timezone: originalTimezone } })
      .catch(() => null)
    await deleteAccount(request, admin, operator.id)
  }
})
