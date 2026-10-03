import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'

import { ArtifactStore } from './artifacts.js'
import { ApiClient } from './api.js'

type GovernanceFixture = {
  activate_policy_id: number
  reject_policy_id: number
  release_quarantine_id: number
  replay_quarantine_id: number
  quarantine_replay_id: number
  standalone_replay_id: number
}

function seedGovernanceFixture(
  fixtureScript: string,
  runId: string,
  streamId: number,
  destinationId: number,
  routeId: number,
): GovernanceFixture {
  const run = spawnSync(
    'python3',
    [
      fixtureScript,
      'seed-governance-ops',
      '--run-id',
      runId,
      '--stream-id',
      String(streamId),
      '--destination-id',
      String(destinationId),
      '--route-id',
      String(routeId),
    ],
    { env: process.env, encoding: 'utf8' },
  )
  if (run.status !== 0) {
    const detail = String(run.stderr || run.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 400)
    throw new Error(`governance fixture failed${detail ? `: ${detail}` : ''}`)
  }
  const line = String(run.stdout || '')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) throw new Error('governance fixture produced no JSON result')
  return JSON.parse(line) as GovernanceFixture
}

async function clickAction(page: Page, testId: string): Promise<void> {
  const button = page.getByTestId(testId)
  await button.waitFor({ state: 'visible', timeout: 15_000 })
  await button.click()
}

async function approvalDetail(api: ApiClient, policyId: number) {
  const res = await api.request('GET', `/api/v1/governance/approvals/${policyId}`)
  return { status: res.status, body: res.json as Record<string, unknown> }
}

async function quarantineDetail(api: ApiClient, id: number) {
  const res = await api.request('GET', `/api/v1/governance/quarantine/${id}?window=30d`)
  return { status: res.status, body: res.json as Record<string, unknown> }
}

async function replayDetail(api: ApiClient, id: number) {
  const res = await api.request('GET', `/api/v1/governance/replay/${id}?window=30d`)
  return { status: res.status, body: res.json as Record<string, unknown> }
}

function uiUrl(uiBase: string, route: string): string {
  return `${uiBase.replace(/\/+$/, '')}${route}`
}

async function openApproval(page: Page, uiBase: string, policyId: number): Promise<void> {
  await page.goto(uiUrl(uiBase, '/governance/approvals'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.getByTestId('approval-workflow-page').waitFor({ timeout: 15_000 })
  const row = page.getByTestId(`approval-row-${policyId}`)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByTestId('approval-detail-drawer').waitFor({ timeout: 15_000 })
}

async function runApprovalActivate(page: Page, api: ApiClient, uiBase: string, policyId: number): Promise<boolean> {
  await openApproval(page, uiBase, policyId)
  await clickAction(page, 'approval-action-submit')
  await page.getByTestId('approval-action-approve').waitFor({ timeout: 15_000 })
  await clickAction(page, 'approval-action-approve')
  await page.getByTestId('approval-action-activate').waitFor({ timeout: 15_000 })
  await clickAction(page, 'approval-action-activate')
  await page.waitForTimeout(300)
  const detail = await approvalDetail(api, policyId)
  return detail.status < 300 && detail.body.current_status === 'ACTIVE'
}

async function runApprovalReject(page: Page, api: ApiClient, uiBase: string, policyId: number): Promise<boolean> {
  await openApproval(page, uiBase, policyId)
  await clickAction(page, 'approval-action-submit')
  await page.getByTestId('approval-action-reject').waitFor({ timeout: 15_000 })
  await clickAction(page, 'approval-action-reject')
  await page.waitForTimeout(300)
  const detail = await approvalDetail(api, policyId)
  const history = Array.isArray(detail.body.history) ? detail.body.history : []
  return (
    detail.status < 300 &&
    detail.body.current_status === 'DRAFT' &&
    history.some((row) => (row as Record<string, unknown>).event_type === 'REJECTED')
  )
}

async function runQuarantineAction(
  page: Page,
  api: ApiClient,
  uiBase: string,
  id: number,
  action: 'release' | 'replay',
): Promise<boolean> {
  await page.goto(uiUrl(uiBase, '/governance/quarantine'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.getByTestId('quarantine-center-page').waitFor({ timeout: 15_000 })
  const row = page.getByTestId(`quarantine-row-${id}`)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByTestId('quarantine-detail-drawer').waitFor({ timeout: 15_000 })
  await clickAction(page, `quarantine-action-${action}`)
  const dialog = `quarantine-center-${action}-dialog`
  await page.getByTestId(dialog).waitFor({ timeout: 15_000 })
  const actionResponse = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/api/v1/governance/quarantine/${action}`),
      { timeout: 15_000 },
    )
    .catch(() => null)
  await clickAction(page, `${dialog}-confirm`)
  const response = await actionResponse
  const actionCompleted = await page
    .getByTestId(dialog)
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!actionCompleted) return false

  if (action === 'replay') {
    if (!response || response.status() >= 300) return false
    const payload = (await response.json().catch(() => null)) as
      | { failed?: number; succeeded?: number; results?: Array<{ outcome?: string; replay_event_id?: number }> }
      | null
    const result = payload?.results?.[0]
    const replayId = Number(result?.replay_event_id || 0)
    if (payload?.failed !== 0 || payload?.succeeded !== 1 || result?.outcome !== 'replayed' || replayId <= 0) {
      return false
    }
    const replay = await replayDetail(api, replayId)
    const replayEntry = (replay.body.entry ?? {}) as Record<string, unknown>
    return replay.status < 300 && replayEntry.status === 'COMPLETED'
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const detail = await quarantineDetail(api, id)
    const entry = (detail.body.entry ?? {}) as Record<string, unknown>
    if (detail.status < 300 && entry.status === 'RELEASED') return true
    await page.waitForTimeout(250)
  }
  return false
}

async function runStandaloneReplay(page: Page, api: ApiClient, uiBase: string, id: number): Promise<boolean> {
  await page.goto(uiUrl(uiBase, '/governance/replay'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.getByTestId('replay-center-page').waitFor({ timeout: 15_000 })
  const row = page.getByTestId(`replay-row-${id}`)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByTestId('replay-detail-drawer').waitFor({ timeout: 15_000 })
  await clickAction(page, 'replay-action-execute')
  await page.getByTestId('replay-center-execute-dialog').waitFor({ timeout: 15_000 })
  await clickAction(page, 'replay-center-execute-dialog-confirm')
  await page.waitForTimeout(500)
  const detail = await replayDetail(api, id)
  const entry = (detail.body.entry ?? {}) as Record<string, unknown>
  return detail.status < 300 && entry.status === 'COMPLETED'
}
async function verifyGovernanceSurfaces(
  page: Page,
  uiBase: string,
  streamId: number,
  routeId: number,
): Promise<Record<string, boolean>> {
  const checks: Array<[string, string]> = [
    ['/governance/violations', 'violation-center-page'],
    ['/governance/notifications', 'governance-notifications-page'],
    ['/governance/audit', 'audit-trail-page'],
  ]
  const out: Record<string, boolean> = {}
  for (const [route, testId] of checks) {
    await page.goto(uiUrl(uiBase, route), { waitUntil: 'domcontentloaded', timeout: 15_000 })
    out[testId] = await page
      .getByTestId(testId)
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
  }
  await page.goto(
    uiUrl(uiBase, `/governance/workspace?stream_id=${streamId}&route_id=${routeId}`),
    { waitUntil: 'domcontentloaded', timeout: 15_000 },
  )
  out.workspace = await page.getByTestId('governance-workspace-page').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
  out.context = await page.getByTestId('governance-workspace-active-context').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
  out.route = await page.getByTestId(`governance-workspace-route-row-${routeId}`).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
  return out
}

export async function runGovernanceLifecycle(opts: {
  page: Page
  api: ApiClient
  store: ArtifactStore
  runId: string
  uiBase: string
  fixtureScript: string
  streamId: number
  destinationId: number
  routeId: number
}): Promise<void> {
  const { page, api, store, runId, uiBase, fixtureScript, streamId, destinationId, routeId } = opts
  let releaseRestoreRequired = false
  try {
    const fixture = seedGovernanceFixture(fixtureScript, runId, streamId, destinationId, routeId)
    store.writeJson('governance-fixture-ids.json', fixture)

    const activated = await runApprovalActivate(page, api, uiBase, fixture.activate_policy_id)
    store.rec('BFS015_APPROVAL_ACTIVATE', activated ? 'PASS' : 'FAIL', `policy=${fixture.activate_policy_id}`, [
      'BROWSER_E2E',
      'API_INTEGRATION',
    ])

    const rejected = await runApprovalReject(page, api, uiBase, fixture.reject_policy_id)
    store.rec('BFS015_APPROVAL_REJECT', rejected ? 'PASS' : 'FAIL', `policy=${fixture.reject_policy_id}`, [
      'BROWSER_E2E',
      'API_INTEGRATION',
    ])

    // Release is an explicit operator action and must remain available even when
    // the Stream scheduler is stopped. Reproduce that state explicitly so this
    // browser scenario protects the regression that previously surfaced as HTTP 500.
    const stopResponse = await api.stopStream(streamId)
    const stopAccepted = stopResponse.status < 300
    releaseRestoreRequired = stopAccepted
    const stopped =
      stopAccepted &&
      (await api.getStream(streamId).catch(() => null))?.enabled === false
    const released = await runQuarantineAction(page, api, uiBase, fixture.release_quarantine_id, 'release')
    const restartResponse = await api.startStream(streamId).catch(() => null)
    const restarted =
      restartResponse != null &&
      restartResponse.status < 300 &&
      (await api.getStream(streamId).catch(() => null))?.enabled === true
    if (restarted) releaseRestoreRequired = false
    const releasePass = stopped && released && restarted
    store.rec(
      'BFS015_QUARANTINE_RELEASE',
      releasePass ? 'PASS' : 'FAIL',
      `id=${fixture.release_quarantine_id} stopped=${stopped} released=${released} restarted=${restarted}`,
      ['BROWSER_E2E', 'API_INTEGRATION'],
    )
    const replayed = await runQuarantineAction(page, api, uiBase, fixture.replay_quarantine_id, 'replay')
    store.rec('BFS015_QUARANTINE_REPLAY', replayed ? 'PASS' : 'FAIL', `id=${fixture.replay_quarantine_id}`, [
      'BROWSER_E2E',
      'API_INTEGRATION',
    ])

    const standaloneReplay = await runStandaloneReplay(page, api, uiBase, fixture.standalone_replay_id)
    store.rec('BFS015_REPLAY_EXECUTE', standaloneReplay ? 'PASS' : 'FAIL', `id=${fixture.standalone_replay_id}`, [
      'BROWSER_E2E',
      'API_INTEGRATION',
    ])

    const surfaces = await verifyGovernanceSurfaces(page, uiBase, streamId, routeId)
    store.writeJson('governance-surface-evidence.json', surfaces)
    const surfacesPass = Object.values(surfaces).every(Boolean)
    store.rec(
      'BFS015_GOVERNANCE_SURFACES',
      surfacesPass ? 'PASS' : 'FAIL',
      Object.entries(surfaces).map(([key, value]) => `${key}=${value}`).join(' '),
      ['BROWSER_E2E'],
    )

    const overall = activated && rejected && releasePass && replayed && standaloneReplay && surfacesPass
    store.rec(
      'BFS015_GOVERNANCE_EXHAUSTIVE',
      overall ? 'PASS' : 'FAIL',
      `activate=${activated} reject=${rejected} release=${releasePass} stopped=${stopped} quarantineReplay=${replayed} replay=${standaloneReplay} surfaces=${surfacesPass}`,
      ['BROWSER_E2E', 'API_INTEGRATION'],
    )
  } catch (error) {
    await page.screenshot({ path: `${store.screenshots}/governance-${Date.now()}.png`, fullPage: true }).catch(() => null)
    store.rec('BFS015_GOVERNANCE_EXHAUSTIVE', 'FAIL', String(error).slice(0, 500), ['BROWSER_E2E'])
  } finally {
    if (releaseRestoreRequired) {
      const restoreResponse = await api.startStream(streamId).catch(() => null)
      const restored =
        restoreResponse != null &&
        restoreResponse.status < 300 &&
        (await api.getStream(streamId).catch(() => null))?.enabled === true
      store.rec(
        'BFS015_QUARANTINE_RELEASE_RESTORE',
        restored ? 'PASS' : 'FAIL',
        `stream=${streamId} restored=${restored}`,
        ['API_INTEGRATION'],
      )
    }
  }
}
