import { randomBytes } from 'node:crypto'
import { expect, type APIRequestContext } from '@playwright/test'
import { E2E_PASSWORD, E2E_USERNAME } from './auth-flow'

/**
 * API helpers for the account / governance E2E specs. They run against a DISPOSABLE environment only:
 * the administrator credentials come from PLAYWRIGHT_E2E_USERNAME / PLAYWRIGHT_E2E_PASSWORD (never from the
 * repository) and every test-created account carries a random password generated at run time.
 */

export const hasAdminCredentials = E2E_PASSWORD !== ''
export const MISSING_ADMIN_CREDENTIALS_REASON =
  'Set PLAYWRIGHT_E2E_PASSWORD to the administrator password of the disposable environment (the account must not require a password change).'

export type Account = { id: number; username: string; role: string; password: string }

export function randomPassword(): string {
  return `Pw-${randomBytes(9).toString('base64url')}-Aa1!`
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export type LoginBody = {
  access_token?: string
  refresh_token?: string
  user?: { must_change_password?: boolean }
  detail?: { error_code?: string }
}

export async function login(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<{ status: number; body: LoginBody | null }> {
  const res = await request.post('/api/v1/auth/login', { data: { username, password } })
  return { status: res.status(), body: (await res.json().catch(() => null)) as LoginBody | null }
}

export async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await login(request, E2E_USERNAME, E2E_PASSWORD)
  expect(res.status, 'administrator API login').toBe(200)
  expect(res.body?.user?.must_change_password, 'administrator must not be in the forced-change state').not.toBe(true)
  return String(res.body?.access_token)
}

/** Create an account the way an administrator does; the API marks it must_change_password. */
export async function createAccount(
  request: APIRequestContext,
  token: string,
  role: string,
  label: string,
): Promise<Account> {
  const username = `e2e-${label}-${randomBytes(3).toString('hex')}`
  const password = randomPassword()
  const res = await request.post('/api/v1/admin/users', { headers: bearer(token), data: { username, password, role } })
  expect(res.status(), `create ${role} account`).toBe(201)
  const body = await res.json()
  return { id: Number(body.id), username, role, password }
}

/** Complete the forced first-login change through the API so a test can start from a normal account. */
export async function completeForcedChange(request: APIRequestContext, account: Account): Promise<void> {
  const first = await login(request, account.username, account.password)
  expect(first.status).toBe(200)
  expect(first.body?.user?.must_change_password).toBe(true)
  const next = randomPassword()
  const changed = await request.post('/api/v1/auth/change-password', {
    headers: bearer(String(first.body?.access_token)),
    data: { current_password: account.password, new_password: next, confirm_new_password: next },
  })
  expect(changed.status(), 'forced password change via API').toBe(200)
  account.password = next
}

export async function deleteAccount(request: APIRequestContext, token: string, id: number): Promise<void> {
  await request.delete(`/api/v1/admin/users/${id}`, { headers: bearer(token) }).catch(() => null)
}
