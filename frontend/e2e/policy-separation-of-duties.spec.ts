import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { E2E_PASSWORD, E2E_USERNAME, clearClientSession, gotoAfterLogin, uiLogin } from './helpers/auth-flow'
import {
  MISSING_ADMIN_CREDENTIALS_REASON,
  adminToken,
  bearer,
  completeForcedChange,
  createAccount,
  deleteAccount,
  hasAdminCredentials,
} from './helpers/admin-api'

// F-187: the user who submitted a policy for review may not approve or activate it without an explicit,
// recorded confirmation, and a review whose submitter is not recorded fails closed the same way.
test.describe.configure({ mode: 'serial' })
test.skip(!hasAdminCredentials, MISSING_ADMIN_CREDENTIALS_REASON)

const GOV = '/api/v1/governance'
const SELF_MARKER = '[self-approval override]'
const UNKNOWN_MARKER = '[override: submitter unknown]'
const FIXTURE_SCRIPT = path.resolve(process.cwd(), '..', 'e2e', 'user-lifecycle', 'fixtures', 'seed_fixtures.py')

async function createPolicy(request: APIRequestContext, token: string, label: string): Promise<number> {
  const res = await request.post(`${GOV}/policies`, {
    headers: bearer(token),
    data: {
      name: `E2E SoD ${label} ${randomBytes(3).toString('hex')}`,
      description: 'Disposable separation-of-duties browser spec',
      category: 'DATA_PROTECTION',
      status: 'DRAFT',
      policy_json: {
        conditions: [{ field: 'classification', operator: 'equals', value: 'RESTRICTED' }],
        actions: [{ type: 'audit_only' }],
      },
    },
  })
  expect(res.status(), 'create policy').toBe(201)
  return Number((await res.json()).policy.id)
}

async function submitPolicy(request: APIRequestContext, token: string, id: number): Promise<void> {
  const res = await request.post(`${GOV}/approvals/${id}/submit`, {
    headers: bearer(token),
    data: { comment: 'please review' },
  })
  expect(res.status(), 'submit policy for review').toBe(200)
}

async function approvalDetail(request: APIRequestContext, token: string, id: number) {
  const res = await request.get(`${GOV}/approvals/${id}`, { headers: bearer(token) })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const history = (Array.isArray(body.history) ? body.history : []) as Array<{ event_type: string; comment?: string | null }>
  return {
    status: String(body.current_status),
    approved: body.is_approved === true,
    history,
    comments: history.map((e) => String(e.comment ?? '')),
  }
}

async function openApproval(page: Page, id: number): Promise<void> {
  await gotoAfterLogin(page, '/governance/approvals')
  await expect(page.getByTestId('approval-workflow-page')).toBeVisible()
  await page.getByTestId(`approval-row-${id}`).click()
  await expect(page.getByTestId('approval-detail-drawer')).toBeVisible()
}

test.describe('Policy approval separation of duties (real browser)', () => {
  test('the submitter is blocked by the API and must confirm in the UI to approve and activate their own policy', async ({
    page,
    request,
  }) => {
    const admin = await adminToken(request)

    // The server refuses a plain self-approval with a stable error code.
    const blockedId = await createPolicy(request, admin, 'api-block')
    await submitPolicy(request, admin, blockedId)
    const refused = await request.post(`${GOV}/approvals/${blockedId}/approve`, {
      headers: bearer(admin),
      data: { comment: null },
    })
    expect(refused.status()).toBe(403)
    expect(JSON.stringify(await refused.json())).toContain('GOVERNANCE_SELF_APPROVAL_FORBIDDEN')
    expect((await approvalDetail(request, admin, blockedId)).status).toBe('REVIEW')

    const id = await createPolicy(request, admin, 'self')
    await submitPolicy(request, admin, id)

    await clearClientSession(page)
    await uiLogin(page, E2E_USERNAME, E2E_PASSWORD)
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })
    await openApproval(page, id)
    await expect(page.getByTestId('approval-self-approval-note')).toBeVisible()

    // Approve opens the confirmation; cancelling it changes nothing.
    const dialog = page.getByTestId('approval-self-approval-dialog')
    await page.getByTestId('approval-action-approve').click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Approve your own submission?')
    await page.getByTestId('approval-self-approval-dialog-cancel').click()
    await expect(dialog).toHaveCount(0)
    const afterCancel = await approvalDetail(request, admin, id)
    expect(afterCancel.status).toBe('REVIEW')
    expect(afterCancel.approved).toBe(false)
    expect(afterCancel.history.map((e) => e.event_type)).not.toContain('APPROVED')

    // Confirming records the approval together with the override marker.
    await page.getByTestId('approval-action-approve').click()
    await expect(dialog).toBeVisible()
    await page.getByTestId('approval-self-approval-dialog-confirm').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('approval-action-activate')).toBeVisible()
    const approved = await approvalDetail(request, admin, id)
    expect(approved.approved).toBe(true)
    expect(approved.comments.filter((c) => c.includes(SELF_MARKER))).toHaveLength(1)

    // Activating your own policy needs its own confirmation.
    await page.getByTestId('approval-action-activate').click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Activate your own policy?')
    await page.getByTestId('approval-self-approval-dialog-confirm').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await approvalDetail(request, admin, id)).status).toBe('ACTIVE')
    const activated = await approvalDetail(request, admin, id)
    expect(activated.comments.filter((c) => c.includes(SELF_MARKER))).toHaveLength(2)
  })

  test('a different Governance Approver approves and activates without any confirmation dialog', async ({
    page,
    request,
  }) => {
    const admin = await adminToken(request)
    const approver = await createAccount(request, admin, 'GOVERNANCE_APPROVER', 'approver')
    try {
      await completeForcedChange(request, approver)
      const id = await createPolicy(request, admin, 'other')
      await submitPolicy(request, admin, id)

      await clearClientSession(page)
      await uiLogin(page, approver.username, approver.password)
      await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })
      await openApproval(page, id)
      await expect(page.getByTestId('approval-self-approval-note')).toHaveCount(0)

      await page.getByTestId('approval-action-approve').click()
      await expect(page.getByTestId('approval-action-activate')).toBeVisible()
      await expect(page.getByTestId('approval-self-approval-dialog')).toHaveCount(0)
      await page.getByTestId('approval-action-activate').click()
      await expect.poll(async () => (await approvalDetail(request, admin, id)).status).toBe('ACTIVE')
      const done = await approvalDetail(request, admin, id)
      expect(done.comments.some((c) => c.includes(SELF_MARKER) || c.includes(UNKNOWN_MARKER))).toBe(false)
      await expect(page.getByTestId('approval-self-approval-dialog')).toHaveCount(0)
    } finally {
      await deleteAccount(request, admin, approver.id)
    }
  })

  test('a review with no recorded submitter asks for confirmation before it can be approved', async ({
    page,
    request,
  }) => {
    test.skip(
      process.env.PLAYWRIGHT_E2E_DISPOSABLE_DB !== '1',
      'Set PLAYWRIGHT_E2E_DISPOSABLE_DB=1 (with DATABASE_URL pointing at the disposable database) to seed a REVIEW policy without a submitter.',
    )
    const admin = await adminToken(request)
    const id = await createPolicy(request, admin, 'unknown')
    const seeded = spawnSync('python3', [FIXTURE_SCRIPT, 'force-policy-review', '--policy-id', String(id)], {
      env: process.env,
      encoding: 'utf8',
    })
    expect(seeded.status, String(seeded.stderr || seeded.stdout).slice(0, 300)).toBe(0)

    await clearClientSession(page)
    await uiLogin(page, E2E_USERNAME, E2E_PASSWORD)
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })
    await openApproval(page, id)
    await expect(page.getByTestId('approval-submitter-unknown-note')).toBeVisible()

    const dialog = page.getByTestId('approval-submitter-unknown-dialog')
    await page.getByTestId('approval-action-approve').click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Approve without a recorded submitter?')
    await page.getByTestId('approval-submitter-unknown-dialog-cancel').click()
    await expect(dialog).toHaveCount(0)
    const afterCancel = await approvalDetail(request, admin, id)
    expect(afterCancel.history.map((e) => e.event_type)).not.toContain('APPROVED')

    await page.getByTestId('approval-action-approve').click()
    await expect(dialog).toBeVisible()
    await page.getByTestId('approval-submitter-unknown-dialog-confirm').click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await approvalDetail(request, admin, id)).comments.some((c) => c.includes(UNKNOWN_MARKER)))
      .toBe(true)
  })
})
