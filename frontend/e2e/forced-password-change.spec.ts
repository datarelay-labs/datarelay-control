import { expect, test } from '@playwright/test'
import { clearClientSession, expectLoginScreen, gotoAfterLogin, readAccessToken, uiLogin } from './helpers/auth-flow'
import {
  MISSING_ADMIN_CREDENTIALS_REASON,
  adminToken,
  bearer,
  completeForcedChange,
  createAccount,
  deleteAccount,
  hasAdminCredentials,
  login,
  randomPassword,
} from './helpers/admin-api'

// F-202: accounts an administrator creates must choose their own password at first sign-in, and every
// role - including the read-only and Governance-only ones - can change its own password afterwards.
test.describe.configure({ mode: 'serial' })
test.skip(!hasAdminCredentials, MISSING_ADMIN_CREDENTIALS_REASON)

test.describe('Forced password change and self-service password change (real browser)', () => {
  test('an administrator-created account must change its password before it can use the app', async ({
    page,
    request,
  }) => {
    const admin = await adminToken(request)
    const account = await createAccount(request, admin, 'VIEWER', 'forced')
    try {
      await clearClientSession(page)
      await uiLogin(page, account.username, account.password)

      const gate = page.getByRole('heading', { name: 'Change your password' })
      await expect(gate).toBeVisible()
      await expect(page.locator('#main-content')).toHaveCount(0)

      // The API tells clients plainly why they are refused, and still serves the allow-listed endpoints.
      const token = await readAccessToken(page)
      const blocked = await request.get('/api/v1/connectors/', { headers: bearer(token) })
      expect(blocked.status()).toBe(403)
      expect((await blocked.json()).detail.error_code).toBe('PASSWORD_CHANGE_REQUIRED')
      const who = await request.get('/api/v1/auth/whoami', { headers: bearer(token) })
      expect(who.status()).toBe(200)
      expect((await who.json()).must_change_password).toBe(true)

      // A wrong current password is reported and keeps the user on the gate.
      const next = randomPassword()
      await page.locator('#force-pw-current').fill(randomPassword())
      await page.locator('#force-pw-new').fill(next)
      await page.locator('#force-pw-confirm').fill(next)
      await page.getByRole('button', { name: 'Update password and sign in again' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(gate).toBeVisible()

      // The correct change signs the user out with an explanation and the new password works.
      await page.locator('#force-pw-current').fill(account.password)
      await page.getByRole('button', { name: 'Update password and sign in again' }).click()
      await expectLoginScreen(page)
      await expect(page.getByText('Password updated. Sign in with your new password.')).toBeVisible()

      const stale = await login(request, account.username, account.password)
      expect(stale.status, 'the administrator-typed password no longer works').toBe(400)

      await uiLogin(page, account.username, next)
      await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })
      await expect(gate).toHaveCount(0)
      const fresh = await readAccessToken(page)
      const allowed = await request.get('/api/v1/connectors/', { headers: bearer(fresh) })
      expect(allowed.status()).toBe(200)
    } finally {
      await deleteAccount(request, admin, account.id)
    }
  })

  for (const role of ['VIEWER', 'OPERATOR', 'GOVERNANCE_AUDITOR'] as const) {
    test(`${role} changes its own password from Settings`, async ({ page, request }) => {
      const admin = await adminToken(request)
      const account = await createAccount(request, admin, role, role.toLowerCase())
      try {
        await completeForcedChange(request, account)

        await clearClientSession(page)
        await uiLogin(page, account.username, account.password)
        await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })

        await gotoAfterLogin(page, '/settings')
        await expect(page.getByTestId('admin-password-panel')).toBeVisible()
        // Self-service only: the target is the signed-in account and cannot be edited.
        await expect(page.locator('#pw-user')).toHaveValue(account.username)
        await expect(page.locator('#pw-user')).toBeDisabled()

        const next = randomPassword()
        await page.locator('#pw-cur').fill(account.password)
        await page.locator('#pw-new').fill(next)
        await page.locator('#pw-conf').fill(next)
        const changed = page.waitForResponse(
          (r) => r.url().endsWith('/api/v1/auth/change-password') && r.request().method() === 'POST',
        )
        await page.getByTestId('admin-password-submit').click()
        expect((await changed).status()).toBe(200)

        // The API revokes the account's sessions: the UI ends the session and says why.
        await expectLoginScreen(page)
        await expect(page.getByText('Password updated. Sign in with your new password.')).toBeVisible()
        const stale = await login(request, account.username, account.password)
        expect(stale.status).toBe(400)
        account.password = next

        await uiLogin(page, account.username, account.password)
        await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })
      } finally {
        await deleteAccount(request, admin, account.id)
      }
    })
  }
})
