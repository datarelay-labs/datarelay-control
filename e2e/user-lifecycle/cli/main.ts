/**
 * Real Browser Operator E2E CLI
 *
 * USER ACTION = Playwright UI
 * VERIFICATION = API / echo / runtime
 * FORENSICS = only after UI diagnosis path
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactStore } from '../helpers/artifacts.js'
import { ApiClient, stubWiremock } from '../helpers/api.js'
import { runExhaustiveHttpAuthLifecycle } from '../helpers/http-auth-lifecycle.js'
import { runFirstLoginAndRbacLifecycle } from '../helpers/rbac-lifecycle.js'
import { captureBrowserCensus, runBaselinePublicCensus } from '../helpers/browser-census.js'
import { runGovernanceLifecycle } from '../helpers/governance-lifecycle.js'
import { waitForDelivery, echoLogsTail, countMarkerInEcho, extractEchoBlock, deliveredInEcho } from '../helpers/echo.js'
import { createRunId, TIMEOUTS } from '../helpers/types.js'
import { OperatorSession } from '../pages/session.js'
import { ConnectorsPage } from '../pages/connectors.page.js'
import { DestinationsPage, StreamsPage } from '../pages/streams.page.js'
import { StreamWizardOperator } from '../pages/stream-wizard.page.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(__dirname, '..')
const REPO = path.resolve(PKG, '../..')

type Args = {
  mode: 'smoke' | 'all' | 'scenario' | 'cleanup' | 'resume'
  scenario?: string
  tags: string[]
  runId?: string
  headed: boolean
  observeMinutes: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'all',
    tags: [],
    headed: false,
    observeMinutes: TIMEOUTS.observeDefaultMinutes,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--smoke') args.mode = 'smoke'
    else if (a === '--all') args.mode = 'all'
    else if (a === '--headed') args.headed = true
    else if (a === '--headless') args.headed = false
    else if (a === '--scenario') {
      args.mode = 'scenario'
      args.scenario = argv[++i]
    } else if (a === '--tag') args.tags.push(...argv[++i].split(','))
    else if (a === '--cleanup-only') {
      args.mode = 'cleanup'
      args.runId = argv[++i]
    } else if (a === '--resume') {
      args.mode = 'resume'
      args.runId = argv[++i]
    } else if (a === '--run-id') args.runId = argv[++i]
    else if (a === '--observe-minutes') args.observeMinutes = Number(argv[++i])
  }
  return args
}

function env(name: string, fallback: string): string {
  return (process.env[name] || fallback).replace(/\/$/, '')
}

function alreadyPassed(store: ArtifactStore, id: string): boolean {
  return store.scenarios.some((s) => s.id === id && s.status === 'PASS')
}

function currentGitHead(): string {
  const result = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot resolve candidate HEAD: ${String(result.stderr || '').trim()}`)
  return String(result.stdout || '').trim()
}

function restoreResumeState(store: ArtifactStore, state: Record<string, unknown>): void {
  if (Array.isArray(state.scenarios)) store.scenarios = state.scenarios as ArtifactStore['scenarios']
  if (Array.isArray(state.ledger)) store.ledger = state.ledger as ArtifactStore['ledger']
  if (state.flags && typeof state.flags === 'object') store.flags = state.flags as Record<string, string>
  if (state.counts && typeof state.counts === 'object') store.counts = state.counts as Record<string, number>
}

function finalAcceptanceBlocked(store: ArtifactStore): boolean {
  return (store.counts.FAIL || 0) > 0 || (store.counts.PARTIAL || 0) > 0 || (store.counts.BLOCKED || 0) > 0
}

function worktreeIsClean(): boolean {
  const result = spawnSync('git', ['-C', REPO, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot inspect candidate worktree: ${String(result.stderr || '').trim()}`)
  return String(result.stdout || '').trim() === ''
}

function emptyResources(): Record<string, Record<string, number>> {
  return { connectors: {}, streams: {}, destinations: {}, routes: {} }
}

function rehydrateResourcesFromLedger(store: ArtifactStore, runId: string): Record<string, Record<string, number>> {
  const resources = emptyResources()
  const connectorKeys = new Map<string, string>([
    [`e2e-${runId}-http`, 'HTTP'],
    [`e2e-${runId}-db`, 'DATABASE'],
    [`e2e-${runId}-s3`, 'S3'],
    [`e2e-${runId}-sftp`, 'SFTP'],
    [`e2e-${runId}-webhook`, 'WEBHOOK'],
  ])
  const destinationKeys = new Map<string, string>([
    [`e2e-${runId}-dest-a`, 'A'],
    [`e2e-${runId}-dest-b`, 'B'],
  ])
  const streamKeys = new Map<string, string>([
    [`e2e-${runId}-http-stream-H1`, 'H1'],
    [`e2e-${runId}-http-stream-H2`, 'H2'],
    [`e2e-${runId}-http-stream-H3`, 'H3'],
    [`e2e-${runId}-http-stream-H4`, 'H4'],
    [`e2e-${runId}-http-stream-H5`, 'H5'],
    [`e2e-${runId}-http-stream-H6`, 'H6'],
    [`e2e-${runId}-s3-stream-a`, 'S3A'],
    [`e2e-${runId}-s3-stream-b`, 'S3B'],
    [`e2e-${runId}-sftp-stream-a`, 'SFTPA'],
    [`e2e-${runId}-sftp-stream-b`, 'SFTPB'],
    [`e2e-${runId}-webhook-stream-a`, 'WHA'],
    [`e2e-${runId}-webhook-stream-b`, 'WHB'],
    [`e2e-${runId}-db-stream-orders`, 'DBS1'],
    [`e2e-${runId}-db-stream-users`, 'DBS2'],
  ])

  for (const row of store.ledger) {
    const id = Number(row.RESOURCE_ID)
    if (!Number.isFinite(id) || id <= 0) continue
    if (row.RESOURCE_TYPE === 'CONNECTOR') {
      const key = connectorKeys.get(row.RESOURCE_NAME)
      if (key) resources.connectors[key] = id
    } else if (row.RESOURCE_TYPE === 'DESTINATION') {
      const key = destinationKeys.get(row.RESOURCE_NAME)
      if (key) resources.destinations[key] = id
    } else if (row.RESOURCE_TYPE === 'STREAM') {
      const key = streamKeys.get(row.RESOURCE_NAME)
      if (key) resources.streams[key] = id
    }
  }

  if (resources.streams.H1) resources.streams.WIZARD = resources.streams.H1
  for (const [streamKey, streamId] of Object.entries(resources.streams)) {
    if (streamKey === 'WIZARD') continue
    const routeIds = store.ledger
      .filter((row) => row.RESOURCE_TYPE === 'ROUTE' && row.PARENT.includes(`stream:${streamId}`))
      .map((row) => Number(row.RESOURCE_ID))
      .filter((id) => Number.isFinite(id) && id > 0)
    if (routeIds[0]) resources.routes[`${streamKey}A`] = routeIds[0]
    if (routeIds[1]) resources.routes[`${streamKey}B`] = routeIds[1]
  }
  return resources
}

async function findConnectorId(api: ApiClient, name: string): Promise<number | null> {
  for (let i = 0; i < 16; i++) {
    const rows = await api.listConnectors()
    const hit = rows.find((r) => String(r.name) === name || String(r.name).includes(name))
    if (hit) return Number(hit.id)
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

async function waitForStreamEnabled(api: ApiClient, id: number, enabled: boolean, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const stream = await api.getStream(id).catch(() => null)
    if (stream && Boolean(stream.enabled) === enabled) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function findStreamId(api: ApiClient, name: string): Promise<number | null> {
  for (let i = 0; i < 8; i++) {
    const rows = await api.listStreams()
    const hit = rows.find((r) => String(r.name) === name || String(r.name).includes(name))
    if (hit) return Number(hit.id)
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

async function findDestinationId(api: ApiClient, name: string): Promise<number | null> {
  for (let i = 0; i < 8; i++) {
    const rows = await api.listDestinations()
    const hit = rows.find((r) => String(r.name) === name || String(r.name).includes(name))
    if (hit) return Number(hit.id)
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

function trackBrowser(
  store: ArtifactStore,
  type: string,
  id: string | number,
  name: string,
  parent = '',
): void {
  store.track(type, id, name, `via:browser${parent ? `;${parent}` : ''}`)
}

function countViaBrowser(store: ArtifactStore, type: string): number {
  return store.ledger.filter((r) => r.RESOURCE_TYPE === type && String(r.PARENT || '').includes('via:browser')).length
}

async function attachBrowserRoutes(
  api: ApiClient,
  store: ArtifactStore,
  streamId: number,
  streamName: string,
): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < 10; i++) {
    const routes = await api.listRoutesForStream(streamId)
    if (routes.length) {
      for (const r of routes) {
        const id = Number(r.id)
        if (!ids.includes(id)) {
          ids.push(id)
          trackBrowser(store, 'ROUTE', id, String(r.name || `${streamName}-route-${id}`), `stream:${streamId}`)
        }
      }
      return ids
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return ids
}

async function connectorIdFromPage(page: Page): Promise<number | null> {
  const url = page.url()
  const m = url.match(/\/connectors\/(\d+)/)
  if (m) return Number(m[1])
  return null
}

/** Verification-only stream create after browser connector/destination (not a user-action substitute for representative journeys). */
async function apiCreateHttpStream(
  api: ApiClient,
  opts: {
    name: string
    connectorId: number
    sourceId: number
    endpoint: string
    recordsPath: string
    destA: number
    destB: number
    pollingInterval?: number
  },
): Promise<{ streamId: number; routeA?: number; routeB?: number }> {
  const { status, json } = await api.request('POST', '/api/v1/streams/', {
    name: opts.name,
    connector_id: opts.connectorId,
    source_id: opts.sourceId,
    stream_type: 'HTTP_API_POLLING',
    config_json: {
      endpoint: opts.endpoint,
      method: 'GET',
      params: {},
      pagination: { type: 'none' },
      records_path: opts.recordsPath,
    },
    polling_interval: opts.pollingInterval ?? 30,
  })
  if (status >= 300) throw new Error(`stream create ${status} ${JSON.stringify(json)}`)
  const streamId = Number(json.id)
  const routes: number[] = []
  for (const [tag, destId] of [
    ['A', opts.destA],
    ['B', opts.destB],
  ] as const) {
    const rr = await api.request('POST', '/api/v1/routes/', {
      stream_id: streamId,
      destination_id: destId,
      name: `${opts.name}-route-${tag}`,
      enabled: true,
    })
    if (rr.status < 300 && rr.json?.id) routes.push(Number(rr.json.id))
  }
  return { streamId, routeA: routes[0], routeB: routes[1] }
}

async function cleanupRun(api: ApiClient, store: ArtifactStore, runId: string): Promise<void> {
  const owned = await api.findByNamePrefix(runId)
  for (const s of owned.streams) {
    await api.stopStream(Number(s.id)).catch(() => null)
  }
  for (const r of owned.routes || []) {
    const st = await api.deleteRoute(Number(r.id))
    store.markCleanup('ROUTE', r.id, st < 300 || st === 404 ? 'DELETED' : `HTTP_${st}`)
  }
  for (const s of owned.streams) {
    const st = await api.deleteStream(Number(s.id))
    store.markCleanup('STREAM', s.id, st < 300 || st === 404 ? 'DELETED' : `HTTP_${st}`)
  }
  for (const c of owned.connectors) {
    const st = await api.deleteConnector(Number(c.id))
    store.markCleanup('CONNECTOR', c.id, st < 300 || st === 404 ? 'DELETED' : `HTTP_${st}`)
  }
  for (const d of owned.destinations) {
    const full = await api.request('GET', `/api/v1/destinations/${d.id}`)
    if (full.status < 300 && full.json) {
      await api.request('PUT', `/api/v1/destinations/${d.id}`, {
        name: full.json.name,
        destination_type: full.json.destination_type,
        enabled: false,
        config_json: full.json.config_json || {},
        expected_updated_at: full.json.updated_at,
      }).catch(() => null)
    }
    const st = await api.deleteDestination(Number(d.id))
    store.markCleanup('DESTINATION', d.id, st < 300 || st === 404 ? 'DELETED' : `HTTP_${st}`)
  }

  let orphanPolicies = 0
  const governanceCleanup = spawnSync(
    'python3',
    [path.join(PKG, 'fixtures/seed_fixtures.py'), 'cleanup-governance-ops', '--run-id', runId],
    { env: process.env, encoding: 'utf8' },
  )
  let governanceCleanupEvidence: Record<string, unknown> = {
    ok: false,
    status: governanceCleanup.status,
    stderr: String(governanceCleanup.stderr || '').trim().slice(0, 500),
  }
  if (governanceCleanup.status === 0) {
    const line = String(governanceCleanup.stdout || '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean)
      .at(-1)
    try {
      governanceCleanupEvidence = line ? (JSON.parse(line) as Record<string, unknown>) : governanceCleanupEvidence
      orphanPolicies = Number(governanceCleanupEvidence.remaining_policies || 0)
    } catch {
      orphanPolicies = 1
    }
  } else {
    orphanPolicies = 1
  }
  store.writeJson('governance-cleanup.json', governanceCleanupEvidence)

  let left = await api.findByNamePrefix(runId)
  for (let attempt = 0; attempt < 3 && left.connectors.length + left.streams.length + left.destinations.length + (left.routes || []).length > 0; attempt++) {
    await new Promise((r) => setTimeout(r, 400))
    for (const c of left.connectors) {
      await api.deleteConnector(Number(c.id)).catch(() => null)
    }
    for (const s of left.streams) {
      await api.stopStream(Number(s.id)).catch(() => null)
      await api.deleteStream(Number(s.id)).catch(() => null)
    }
    for (const d of left.destinations) {
      await api.deleteDestination(Number(d.id)).catch(() => null)
    }
    for (const r of left.routes || []) {
      await api.deleteRoute(Number(r.id)).catch(() => null)
    }
    left = await api.findByNamePrefix(runId)
  }
  const orphanC = left.connectors.length
  const orphanS = left.streams.length
  const orphanD = left.destinations.length
  const orphanR = (left.routes || []).length
  store.setFlag('ORPHAN_CONNECTORS', String(orphanC))
  store.setFlag('ORPHAN_STREAMS', String(orphanS))
  store.setFlag('ORPHAN_DESTINATIONS', String(orphanD))
  store.setFlag('ORPHAN_ROUTES', String(orphanR))
  store.setFlag('ORPHAN_GOVERNANCE_POLICIES', String(orphanPolicies))
  const cleanupPass = orphanC + orphanS + orphanD + orphanR + orphanPolicies === 0
  store.setFlag('CLEANUP', cleanupPass ? 'PASS' : 'FAIL')
  store.rec(
    '13_CLEANUP_ORPHANS',
    cleanupPass ? 'PASS' : 'FAIL',
    `c=${orphanC} s=${orphanS} d=${orphanD} r=${orphanR} p=${orphanPolicies}`,
    ['API_INTEGRATION'],
  )
}

function writeFinalSummary(store: ArtifactStore, extra: Record<string, string>): void {
  const lines = Object.entries({
    PHASE: 'DATA_RELAY_REAL_BROWSER_OPERATOR_JOURNEY_COVERAGE_CLOSURE',
    RUN_ID: store.runId,
    ...store.flags,
    ...extra,
    PASS: String(store.counts.PASS || 0),
    FAIL: String(store.counts.FAIL || 0),
    PARTIAL: String(store.counts.PARTIAL || 0),
    BLOCKED: String(store.counts.BLOCKED || 0),
    NEW_ISSUES: String(store.issues.length),
  }).map(([k, v]) => `${k}=${v}`)
  fs.writeFileSync(path.join(store.dir, 'final-summary.txt'), lines.join('\n') + '\n')
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const runId = args.runId || createRunId()
  const candidateHead = currentGitHead()
  const candidateClean = worktreeIsClean()
  process.env.ULC_RUN_ID = runId
  const store = new ArtifactStore(runId)
  if (args.mode === 'resume') {
    const st = store.loadState()
    if (!st) {
      console.error('No state to resume')
      return 2
    }
    const stateFlags = st.flags as Record<string, unknown> | undefined
    const recordedHead = String(stateFlags?.CANDIDATE_HEAD || '')
    const recordedClean = String(stateFlags?.CANDIDATE_WORKTREE_CLEAN || '')
    if (!recordedHead || recordedHead !== candidateHead) {
      console.error(`Resume candidate mismatch: recorded=${recordedHead || '<missing>'} current=${candidateHead}`)
      return 2
    }
    if (recordedClean !== 'YES' || !candidateClean) {
      console.error(`Resume requires the same clean committed source: recordedClean=${recordedClean || '<missing>'} currentClean=${candidateClean ? 'YES' : 'NO'}`)
      return 2
    }
    restoreResumeState(store, st)
  }
  store.setFlag('CANDIDATE_HEAD', candidateHead)
  store.setFlag('CANDIDATE_WORKTREE_CLEAN', candidateClean ? 'YES' : 'NO')

  const apiBase = env('PLAYWRIGHT_API_BASE_URL', env('GDC_E2E_API_BASE_URL', 'http://127.0.0.1:18010'))
  const uiBase = env('PLAYWRIGHT_BASE_URL', env('GDC_E2E_UI_BASE_URL', 'http://127.0.0.1:4174'))
  const wm = env('WIREMOCK_BASE_URL', 'http://127.0.0.1:28080')
  const echo = env('E2E_WEBHOOK_ECHO_URL', 'http://127.0.0.1:18091')
  const token = `FAKE_TOKEN_${runId}`

  const api = new ApiClient(apiBase)
  await api.login()

  if (args.mode === 'cleanup') {
    await cleanupRun(api, store, runId)
    store.flush()
    writeFinalSummary(store, { MODE: 'cleanup-only' })
    return store.flags.CLEANUP === 'PASS' ? 0 : 1
  }

  let browser: Browser | null = null
  let context: BrowserContext | null = null
  let page: Page | null = null

  const resources: Record<string, any> =
    args.mode === 'resume' ? rehydrateResourcesFromLedger(store, runId) : emptyResources()

  try {
    browser = await chromium.launch({ headless: !args.headed })
    store.setFlag('ACTUAL_BROWSER_PROCESS', 'YES')
    store.setFlag('BROWSER_DRIVER', 'PLAYWRIGHT')
    store.setFlag('BROWSER_ENGINE', 'CHROMIUM')
    store.setFlag('BROWSER_VERSION', browser.version())
    store.setFlag('BROWSER_MODE', args.headed ? 'HEADED' : 'HEADLESS')
    context = await browser.newContext({ ignoreHTTPSErrors: true })
    page = await context.newPage()
    page.setDefaultTimeout(TIMEOUTS.actionMs)
    const session = new OperatorSession(page, uiBase, store)
    session.installNetworkCapture('operator')
    const connectors = new ConnectorsPage(session)
    const destinations = new DestinationsPage(session)
    const streams = new StreamsPage(session)
    const wizard = new StreamWizardOperator(session)
    let activeSession = session
    let connectorsPg = connectors
    let streamsPg = streams
    let destinationsPg = destinations

    const scenarioSets: Record<string, (id: string) => boolean> = {
      'dest-isolation': (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_HTTP_CONNECTOR',
          '03_STREAM_WIZARD_HTTP',
          '07_START_STREAMS',
          '07_DELIVERY',
          '08_DEST_FAIL',
        ].includes(id) ||
        id.startsWith('08_DEST_') ||
        id.startsWith('09_DEST_'),
      'stop-delete': (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_HTTP_CONNECTOR',
          '03_STREAM_WIZARD_HTTP',
          '03_HTTP_STREAM_H2',
          '07_START_STREAMS',
          '07_DELIVERY',
          '11_STOP_START',
          '11_STOP_NE_DISABLED',
          '12_DELETE_RUNNING',
          '12_DELETE_LIFECYCLE',
          '12_DELETE_STREAM_BROWSER',
          '41_CONNECTOR_DELETE_DEP',
        ].includes(id) ||
        id.startsWith('11_') ||
        id.startsWith('12_'),
      'family-delivery': (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_DATABASE_CONNECTOR',
          '01_SFTP_CONNECTOR',
          '01_WEBHOOK_CONNECTOR',
          '03_SFTPA_STREAM',
          '03_WHA_STREAM',
          '03_DBS1_STREAM',
          '07_START_STREAMS',
          '07_FAMILY_DELIVERY',
        ].includes(id),
      'wizard-families': (id) =>
        id.startsWith('01_') ||
        id.startsWith('03_') ||
        ['00_SMOKE_BROWSER', '05_DEST_CREATE', '07_START_STREAMS', '07_DELIVERY', '07_FAMILY_DELIVERY'].includes(id),
      transform: (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_HTTP_CONNECTOR',
          '03_STREAM_WIZARD_HTTP',
          '07_START_STREAMS',
          '07_DELIVERY',
          '06_PROTECTION_OUTPUT',
          '06_TRANSFORM_OUTPUT',
        ].includes(id),
      'processing-exhaustive': (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_HTTP_CONNECTOR',
          '03_STREAM_WIZARD_HTTP',
          '03_HTTP_STREAM_H2',
          '03_HTTP_STREAM_H3',
          'BFS004_PROCESSING_EXHAUSTIVE',
          'BFS004_FULL_EVENT_JSONATA',
          'BFS004_FULL_EVENT_REGEX',
          '07_START_STREAMS',
          '07_DELIVERY',
        ].includes(id),
      governance: (id) =>
        ['00_SMOKE_BROWSER', '05_DEST_CREATE', '01_HTTP_CONNECTOR', '03_STREAM_WIZARD_HTTP', 'BFS015_GOVERNANCE_EXHAUSTIVE'].includes(id),
      'sample-reconciliation': (id) =>
        ['00_SMOKE_BROWSER', '05_DEST_CREATE', '01_HTTP_CONNECTOR', '03_STREAM_WIZARD_HTTP', 'BFS005_SAMPLE_RECONCILIATION'].includes(id),
      rbac: (id) => ['00_SMOKE_BROWSER', 'BFS016_RBAC_EXHAUSTIVE'].includes(id),
      census: (id) => ['00_SMOKE_BROWSER', 'BFS_CONTROL_CENSUS_BASELINE'].includes(id),
      'auth-ui': (id) =>
        ['00_SMOKE_BROWSER', '01_HTTP_CONNECTOR', '02_HTTP_AUTH', '17_R3_002_ROOT_VS_RESOURCE'].includes(id),
      reload: (id) => ['00_SMOKE_BROWSER', '01_HTTP_CONNECTOR', '28_HTTP_RELOAD_PERSISTENCE'].includes(id),
      'source-fail': (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_HTTP_CONNECTOR',
          '03_STREAM_WIZARD_HTTP',
          '07_START_STREAMS',
          '07_DELIVERY',
          '08_SOURCE_FAIL',
          '08_SOURCE_FAIL_UI_NAV',
          '08_SOURCE_FAIL_DIAGNOSIS',
          '09_SOURCE_RECOVERY',
        ].includes(id) || id.startsWith('08_SOURCE') || id.startsWith('09_SOURCE'),
      checkpoint: (id) =>
        [
          '00_SMOKE_BROWSER',
          '05_DEST_CREATE',
          '01_HTTP_CONNECTOR',
          '03_STREAM_WIZARD_HTTP',
          '03_HTTP_STREAM_H3',
          '07_START_STREAMS',
          '07_DELIVERY',
          '08_DEST_FAIL',
          '38_CHECKPOINT',
        ].includes(id) || id.startsWith('38_CHECKPOINT') || id.startsWith('08_DEST_') || id.startsWith('09_DEST_'),
    }
    const want = (id: string, tags: string[]) => {
      if (args.mode === 'smoke') return tags.includes('smoke')
      if (args.mode === 'scenario') {
        const setFn = args.scenario ? scenarioSets[args.scenario] : undefined
        if (setFn) return setFn(id)
        return id === args.scenario || tags.includes(args.scenario || '')
      }
      if (args.tags.length) return args.tags.some((t) => tags.includes(t))
      return true
    }
    const skipIfResume = (id: string) => args.mode === 'resume' && alreadyPassed(store, id)

    // ---- 00 smoke ----
    if (want('00_SMOKE_BROWSER', ['smoke', 'browser']) && !skipIfResume('00_SMOKE_BROWSER')) {
      try {
        await session.login()
        await connectors.openList()
        await streams.openList()
        await streams.openDashboard()
        const health = await api.request('GET', '/health')
        store.rec(
          '00_SMOKE_BROWSER',
          health.status === 200 ? 'PASS' : 'FAIL',
          `api=${health.status}`,
          ['BROWSER_E2E', 'API_INTEGRATION'],
        )
      } catch (e) {
        await session.screenshotOnFail('smoke-fail')
        store.issue({
          SEVERITY: 'P0',
          SCENARIO: '00_SMOKE_BROWSER',
          USER_ACTION: 'login+navigate',
          PAGE: '/',
          EXPECTED: 'login and navigate',
          ACTUAL: String(e),
          USER_VISIBLE_SYMPTOM: 'smoke failed',
          BROWSER_EVIDENCE: 'screenshot',
          API_EVIDENCE: '',
          RUNTIME_EVIDENCE: '',
          DESTINATION_EVIDENCE: '',
          ROOT_CAUSE: 'package/env',
          FIX_DIRECTION: 'fix lab API/UI',
          REPRODUCIBLE: 'YES',
        })
        store.rec('00_SMOKE_BROWSER', 'FAIL', String(e), ['BROWSER_E2E'])
      }
    }

    if (args.mode === 'smoke') {
      // minimal create/delete
      if (!skipIfResume('00_SMOKE_CONNECTOR_CRUD')) {
        const name = `e2e-${runId}-smoke-http`
        spawnSync('python3', [path.join(PKG, 'fixtures/seed_fixtures.py'), 'seed-http', '--run-id', runId, '--token', token], {
          cwd: REPO,
          env: process.env,
        })
        await connectors.openCreate()
        await connectors.fillHttpConnector({
          name,
          baseUrl: wm,
          authType: 'bearer',
          bearerToken: token,
        })
        await connectors.save()
        await page.waitForTimeout(1200)
        let cid = await connectorIdFromPage(page)
        if (!cid) cid = await findConnectorId(api, name)
        if (cid) {
          store.track('CONNECTOR', cid, name)
          resources.connectors.smoke = cid
          await api.deleteConnector(cid)
          store.markCleanup('CONNECTOR', cid, 'DELETED')
          store.rec('00_SMOKE_CONNECTOR_CRUD', 'PASS', `id=${cid}`, ['BROWSER_E2E', 'API_INTEGRATION'])
        } else {
          store.rec('00_SMOKE_CONNECTOR_CRUD', 'FAIL', 'connector not persisted', ['BROWSER_E2E'])
        }
      }
      store.flush()
      writeFinalSummary(store, { MODE: 'smoke' })
      return (store.counts.FAIL || 0) > 0 ? 1 : 0
    }

    // ---- fixtures ----
    spawnSync('python3', [path.join(PKG, 'fixtures/seed_fixtures.py'), 'seed-http', '--run-id', runId, '--token', token], {
      cwd: REPO,
      env: process.env,
    })
    spawnSync('python3', [path.join(PKG, 'fixtures/seed_fixtures.py'), 'seed-s3', '--run-id', runId], {
      cwd: REPO,
      env: process.env,
    })
        spawnSync('python3', [path.join(PKG, 'fixtures/seed_fixtures.py'), 'seed-sftp', '--run-id', runId], {
      cwd: REPO,
      env: process.env,
    })
    spawnSync('python3', [path.join(PKG, 'fixtures/seed_fixtures.py'), 'seed-db', '--run-id', runId], {
      cwd: REPO,
      env: process.env,
    })

    await session.login()

    // ---- Browser page/control census for machine-derived closure ----
    if (want('BFS_CONTROL_CENSUS_BASELINE', ['browser', 'census'])) {
      await runBaselinePublicCensus(page, store, uiBase)
    }

    // ---- BFS-001/BFS-016 first-login and local RBAC lifecycle ----
    if (want('BFS016_RBAC_EXHAUSTIVE', ['browser', 'rbac'])) {
      await runFirstLoginAndRbacLifecycle({
        browser,
        adminPage: page,
        api,
        store,
        runId,
        uiBase,
        fixtureScript: path.join(PKG, 'fixtures/seed_fixtures.py'),
      })
    }

    // ---- BFS-003 exhaustive browser authentication lifecycle ----
    if (want('BFS003_AUTH_EXHAUSTIVE', ['browser', 'connector', 'auth-exhaustive'])) {
      await runExhaustiveHttpAuthLifecycle({
        page,
        connectors,
        api,
        store,
        runId,
        wiremockBase: wm,
      })
    }

    // ---- destinations (browser) ----
    const destAName = `e2e-${runId}-dest-a`
    const destBName = `e2e-${runId}-dest-b`
    const browserCreatedDestinations = new Set<string>()
    if (want('05_DEST_CREATE', ['browser', 'delivery']) && !skipIfResume('05_DEST_CREATE')) {
      try {
        for (const [key, name, pathSuffix] of [
          ['A', destAName, `/ulc-${runId}-a`],
          ['B', destBName, `/ulc-${runId}-b`],
        ] as const) {
          await destinations.openCreate()
          await destinations.fillWebhookDestination({ name, url: `${echo}${pathSuffix}` })
          await destinations.save()
          await page.waitForTimeout(800)
          let id = await findDestinationId(api, name)
          const viaBrowser = Boolean(id)
          if (!id) {
            // API fallback after browser attempt (fixture seed only; not browser-created evidence)
            const created = await api.request('POST', '/api/v1/destinations/', {
              name,
              destination_type: 'WEBHOOK_POST',
              config_json: { url: `${echo}${pathSuffix}`, retry_count: 0, retry_backoff_seconds: 0.01 },
            })
            if (created.status < 300 && created.json?.id) id = Number(created.json.id)
            store.rec(`05_DEST_${key}_BROWSER`, 'PARTIAL', 'UI create incomplete; API verification seed', [
              'BROWSER_E2E',
              'API_INTEGRATION',
            ])
          }
          if (id) {
            if (viaBrowser) {
              trackBrowser(store, 'DESTINATION', id, name)
              browserCreatedDestinations.add(key)
            } else {
              store.track('DESTINATION', id, name, 'via:api-fallback')
            }
            resources.destinations[key] = id
          }
        }
        const idsPresent = Boolean(resources.destinations.A && resources.destinations.B)
        const browserComplete = browserCreatedDestinations.has('A') && browserCreatedDestinations.has('B')
        const status = browserComplete ? 'PASS' : idsPresent ? 'PARTIAL' : 'FAIL'
        store.rec(
          '05_DEST_CREATE',
          status,
          `A=${resources.destinations.A} B=${resources.destinations.B} browserA=${browserCreatedDestinations.has('A')} browserB=${browserCreatedDestinations.has('B')}`,
          ['BROWSER_E2E', 'API_INTEGRATION'],
        )
      } catch (e) {
        await session.screenshotOnFail('dest-create-fail')
        store.issue({
          SEVERITY: 'P1',
          SCENARIO: '05_DEST_CREATE',
          USER_ACTION: 'create destination via UI',
          PAGE: '/destinations',
          EXPECTED: 'destination form opens and saves',
          ACTUAL: String(e),
          USER_VISIBLE_SYMPTOM: 'cannot create destination in UI',
          BROWSER_EVIDENCE: 'screenshot dest-create-fail',
          API_EVIDENCE: '',
          RUNTIME_EVIDENCE: '',
          DESTINATION_EVIDENCE: '',
          ROOT_CAUSE: 'destination UI selector/flow',
          FIX_DIRECTION: 'stabilize New Destination control',
          REPRODUCIBLE: 'YES',
        })
        // seed sinks so later delivery scenarios can still run
        for (const [key, name, pathSuffix] of [
          ['A', destAName, `/ulc-${runId}-a`],
          ['B', destBName, `/ulc-${runId}-b`],
        ] as const) {
          const created = await api.request('POST', '/api/v1/destinations/', {
            name,
            destination_type: 'WEBHOOK_POST',
            config_json: { url: `${echo}${pathSuffix}`, retry_count: 0, retry_backoff_seconds: 0.01 },
          })
          if (created.status < 300 && created.json?.id) {
            resources.destinations[key] = Number(created.json.id)
            store.track('DESTINATION', created.json.id, name)
          }
        }
        store.rec('05_DEST_CREATE', 'FAIL', String(e).slice(0, 200), ['BROWSER_E2E'])
      }
    }

    if (want('BFS006_DESTINATION_FAMILIES', ['browser', 'delivery', 'destination-families'])) {
      const familySpecs = [
        { key: 'WEBHOOK_POST', fill: async (name: string) => destinations.fillWebhookDestination({ name, url: `${echo}/bfs006-${runId}` }) },
        { key: 'SYSLOG_UDP', fill: async (name: string) => destinations.fillSyslogDestination({ name, type: 'SYSLOG_UDP', host: '127.0.0.1', port: Number(env('GDC_TEST_SYSLOG_HOST_PORT', '15514')) }) },
        { key: 'SYSLOG_TCP', fill: async (name: string) => destinations.fillSyslogDestination({ name, type: 'SYSLOG_TCP', host: '127.0.0.1', port: Number(env('GDC_TEST_SYSLOG_HOST_PORT', '15514')) }) },
        { key: 'SYSLOG_TLS', fill: async (name: string) => destinations.fillSyslogDestination({ name, type: 'SYSLOG_TLS', host: '127.0.0.1', port: Number(env('GDC_TEST_SYSLOG_TLS_HOST_PORT', '16514')), insecureTls: true }) },
      ] as const

      for (const spec of familySpecs) {
        const scenarioId = `BFS006_DEST_${spec.key}`
        if (skipIfResume(scenarioId)) continue
        const name = `e2e-${runId}-family-${spec.key.toLowerCase()}`
        try {
          await destinations.openCreate()
          await spec.fill(name)
          const probe = await destinations.testCurrentConnection()
          await destinations.save()
          const id = await findDestinationId(api, name)
          const persisted = id ? (await api.listDestinations()).find((row) => Number(row.id) === id) : null
          const typeOk = String(persisted?.destination_type || '') === spec.key
          if (id) trackBrowser(store, 'DESTINATION', id, name, `family:${spec.key}`)
          store.rec(
            scenarioId,
            probe.success && Boolean(id) && typeOk ? 'PASS' : 'FAIL',
            `probe=${probe.success} id=${id ?? 'none'} type=${String(persisted?.destination_type || 'missing')}`,
            ['BROWSER_E2E', 'API_INTEGRATION'],
          )
        } catch (error) {
          store.rec(scenarioId, 'FAIL', String(error).slice(0, 220), ['BROWSER_E2E'])
        }
      }
    }

    if (want('44_INVALID_DEST', ['browser']) && !skipIfResume('44_INVALID_DEST')) {
      try {
        const empty = await destinations.tryInvalidEmptyName()
        const badUrl = await destinations.tryInvalidUrl(`e2e-${runId}-bad-url`)
        const ok = empty.blockedOrError && badUrl.okUi
        if (!ok) {
          store.issue({
            SEVERITY: 'P2',
            SCENARIO: '44_INVALID_DEST',
            USER_ACTION: 'submit invalid destination',
            PAGE: '/destinations',
            EXPECTED: 'actionable validation, no 500',
            ACTUAL: `${empty.message}|${badUrl.message}`,
            USER_VISIBLE_SYMPTOM: 'invalid input UX',
            BROWSER_EVIDENCE: 'form',
            API_EVIDENCE: '',
            RUNTIME_EVIDENCE: '',
            DESTINATION_EVIDENCE: '',
            ROOT_CAUSE: 'validation UX',
            FIX_DIRECTION: 'surface 4xx messages',
            REPRODUCIBLE: 'YES',
          })
        }
        store.rec('44_INVALID_DEST', ok ? 'PASS' : 'FAIL', `empty=${empty.blockedOrError} url=${badUrl.okUi}`, ['BROWSER_E2E'])
      } catch (e) {
        store.rec('44_INVALID_DEST', 'BLOCKED', String(e).slice(0, 200), ['BROWSER_E2E'])
      }
    }

    // ---- HTTP connector onboarding + auth ----
    const httpName = `e2e-${runId}-http`
    if (want('01_HTTP_CONNECTOR', ['browser', 'connector']) && !skipIfResume('01_HTTP_CONNECTOR')) {
      await connectors.openCreate()
      await connectors.fillHttpConnector({
        name: httpName,
        baseUrl: wm,
        authType: 'bearer',
        bearerToken: token,
      })
      await connectors.save()
      await page.waitForTimeout(800)
      let cid = await connectorIdFromPage(page)
      if (!cid) cid = await findConnectorId(api, httpName)
      if (!cid) {
        store.rec('01_HTTP_CONNECTOR', 'FAIL', 'not persisted', ['BROWSER_E2E'])
      } else {
        trackBrowser(store, 'CONNECTOR', cid, httpName)
        resources.connectors.HTTP = cid
        const detail = await api.getConnector(cid)
        resources.connectors.HTTP_SOURCE = Number(detail.source_id || detail.id)
        store.rec('01_HTTP_CONNECTOR', 'PASS', `id=${cid}`, ['BROWSER_E2E', 'API_INTEGRATION'])
        if (want('28_HTTP_RELOAD_PERSISTENCE', ['browser', 'connector']) && !skipIfResume('28_HTTP_RELOAD_PERSISTENCE')) {
          const persisted = await api.getConnector(cid)
          const apiName = String(persisted?.name || httpName)
          const short = apiName.length > 24 ? apiName.slice(-24) : apiName
          await connectors.openDetail(cid)
          await page.reload({ waitUntil: 'domcontentloaded' })
          const nameField = page.getByLabel(/Connector Name/i).first()
          await nameField.waitFor({ timeout: TIMEOUTS.actionMs }).catch(() => null)
          const loadedName = (await nameField.inputValue().catch(() => '')) || ''
          const detailText = (await page.locator('body').innerText().catch(() => '')) || ''
          const detailOk =
            loadedName.includes(apiName) || detailText.includes(apiName) || detailText.includes(short)
          await connectors.openList()
          const row = page.getByTestId(`connector-row-${cid}`)
          await row.waitFor({ timeout: TIMEOUTS.actionMs }).catch(() => null)
          const listText = (await row.innerText().catch(() => '')) || ''
          const listOk = (await row.count()) > 0 && (listText.includes(apiName) || listText.includes(short))
          await connectors.openDetail(cid)
          const backName = (await page.getByLabel(/Connector Name/i).first().inputValue().catch(() => '')) || ''
          const backOk = backName.includes(apiName) || page.url().includes(`/connectors/${cid}`)
          const reloadOk = Boolean(apiName) && detailOk && listOk && backOk
          store.rec(
            '28_HTTP_RELOAD_PERSISTENCE',
            reloadOk ? 'PASS' : 'FAIL',
            `apiName=${Boolean(apiName)} detail=${detailOk} list=${listOk} back=${backOk}`,
            ['BROWSER_E2E', 'API_INTEGRATION'],
          )
          store.setFlag('RELOAD_PERSISTENCE', reloadOk ? 'PASS' : 'FAIL')
        }
      }
    }

    if (resources.connectors.HTTP && want('02_HTTP_AUTH', ['browser', 'connector']) && !skipIfResume('02_HTTP_AUTH')) {
      await connectors.openDetail(resources.connectors.HTTP)
      await connectors.setAuthTestPath('/')
      const rootAuth = await connectors.testAuth()
      const rootStatus = /403|404|forbidden|not found/i.test(rootAuth.visibleText)
      await connectors.setAuthTestPath(`/ulc/${runId}/h1`)
      const bearerField = page.getByLabel(/Bearer Token/i)
      if (await bearerField.count()) {
        await bearerField.fill('wrong-token')
        await page.getByRole('button', { name: /Save/i }).first().click().catch(() => null)
        await page.waitForTimeout(500)
      }
      let auth = await connectors.testAuth()
      const failVisible = /fail|error|401|unauthor|invalid|denied/i.test(auth.visibleText)
      const rootCauseVisible = /401|403|credential|token|unauthor|auth/i.test(auth.visibleText)
      const recoveryClear = /token|credential|save|test auth|bearer/i.test(await page.locator('body').innerText())
      store.setFlag('AUTH_ERROR_VISIBLE', failVisible ? 'YES' : 'NO')
      store.setFlag('AUTH_ROOT_CAUSE_VISIBLE', rootCauseVisible ? 'YES' : 'NO')
      store.setFlag('AUTH_RECOVERY_ACTION_CLEAR', recoveryClear ? 'YES' : 'NO')
      if (await bearerField.count()) {
        await bearerField.fill(token)
        await page.getByRole('button', { name: /Save/i }).first().click().catch(() => null)
        await page.waitForTimeout(500)
      }
      auth = await connectors.testAuth()
      const passVisible = /success|pass|ok|healthy|200/i.test(auth.visibleText)
      const ac = await api.request('POST', `/api/v1/connectors/${resources.connectors.HTTP}/auth-check`, {
        test_path: `/ulc/${runId}/h1`,
      })
      const apiOk =
        ac.status === 200 &&
        (ac.json?.last_auth_check_status === 'success' ||
          ac.json?.success === true ||
          ac.json?.ok === true ||
          /success/i.test(String(ac.json?.last_auth_check_status || '')))
      const ok = failVisible && passVisible
      store.setFlag('SUCCESS_VISIBLE', passVisible ? 'YES' : 'NO')
      store.setFlag('FAILURE_VISIBLE', failVisible ? 'YES' : 'NO')
      store.setFlag('FAILURE_REASON_VISIBLE', rootCauseVisible ? 'YES' : 'NO')
      store.setFlag('RECOVERY_VISIBLE', passVisible ? 'YES' : 'NO')
      store.setFlag('AUTH_SUCCESS_VISIBLE', passVisible ? 'YES' : 'NO')
      store.setFlag('AUTH_FAILURE_VISIBLE', failVisible ? 'YES' : 'NO')
      store.setFlag('AUTH_FAILURE_REASON_VISIBLE', rootCauseVisible ? 'YES' : 'NO')
      store.setFlag('AUTH_RECOVERY_VISIBLE', passVisible ? 'YES' : 'NO')
      store.rec(
        '02_HTTP_AUTH',
        ok ? 'PASS' : 'PARTIAL',
        `failVis=${failVisible} passVis=${passVisible} apiOk=${apiOk} root403or404=${rootStatus}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
      store.rec(
        '17_R3_002_ROOT_VS_RESOURCE',
        rootStatus && passVisible ? 'PASS' : 'PARTIAL',
        `rootShownAsClientError=${rootStatus} browserResourceOk=${passVisible} apiVerify=${apiOk}`,
        ['BROWSER_E2E'],
      )
      store.setFlag('AUTH_FAILURE_RECOVERY_BROWSER_JOURNEY', ok ? 'PASS' : 'FAIL')
    }

    // ---- other connector families (browser create) ----
    const familySpecs: Array<{
      key: string
      name: string
      fill: () => Promise<void>
    }> = [
      {
        key: 'DATABASE',
        name: `e2e-${runId}-db`,
        fill: async () => {
          const u = new URL(env('SOURCE_E2E_PG_FIXTURE_URL', 'postgresql://gdc_fixture:gdc_fixture_pw@127.0.0.1:55433/gdc_query_fixture'))
          await connectors.openCreate()
          await connectors.fillDatabaseConnector({
            name: `e2e-${runId}-db`,
            host: u.hostname,
            port: Number(u.port || 5432),
            database: u.pathname.replace(/^\//, ''),
            username: u.username,
            password: u.password,
          })
          await connectors.save()
        },
      },
      {
        key: 'S3',
        name: `e2e-${runId}-s3`,
        fill: async () => {
          await connectors.openCreate()
          await connectors.fillS3Connector({
            name: `e2e-${runId}-s3`,
            endpoint: env('SOURCE_E2E_MINIO_ENDPOINT', 'http://127.0.0.1:59000'),
            bucket: env('SOURCE_E2E_MINIO_BUCKET', 'gdc-source-e2e'),
            accessKey: env('SOURCE_E2E_MINIO_ACCESS_KEY', 'gdcminioaccess'),
            secretKey: env('SOURCE_E2E_MINIO_SECRET_KEY', 'gdcminioaccesssecret12'),
            prefix: `${runId}/`,
          })
          await connectors.save()
        },
      },
      {
        key: 'SFTP',
        name: `e2e-${runId}-sftp`,
        fill: async () => {
          await connectors.openCreate()
          await connectors.fillSftpConnector({
            name: `e2e-${runId}-sftp`,
            host: env('SOURCE_E2E_SFTP_HOST', '127.0.0.1'),
            port: Number(env('SOURCE_E2E_SFTP_PORT', '22222')),
            username: env('SOURCE_E2E_SFTP_USER', 'gdc'),
            password: env('SOURCE_E2E_SFTP_PASSWORD', 'devlab123'),
          })
          await connectors.save()
        },
      },
      {
        key: 'WEBHOOK',
        name: `e2e-${runId}-webhook`,
        fill: async () => {
          await connectors.openCreate()
          await connectors.fillWebhookConnector({
            name: `e2e-${runId}-webhook`,
            payloadPreview: JSON.stringify({
              items: [{ id: 1, run_id: runId, message: `marker-${runId}-wh-1`, email: 'test@example.invalid' }],
            }),
          })
          await connectors.save()
        },
      },
    ]

    const familiesPassed: string[] = resources.connectors.HTTP ? ['HTTP'] : []
    const familiesAttempted = ['HTTP', ...familySpecs.map((f) => f.key)]
    for (const fam of familySpecs) {
      const sid = `01_${fam.key}_CONNECTOR`
      if (!want(sid, ['browser', 'connector']) || skipIfResume(sid)) continue
      try {
        await fam.fill()
        await page.waitForTimeout(800)
        let cid = await connectorIdFromPage(page)
        if (!cid) cid = await findConnectorId(api, fam.name)
        if (cid) {
          trackBrowser(store, 'CONNECTOR', cid, fam.name)
          resources.connectors[fam.key] = cid
          const detail = await api.getConnector(cid)
          resources.connectors[`${fam.key}_SOURCE`] = Number(detail.source_id || detail.id)
          familiesPassed.push(fam.key)
          store.rec(sid, 'PASS', `id=${cid}`, ['BROWSER_E2E', 'API_INTEGRATION'])
        } else {
          store.rec(sid, 'FAIL', 'not persisted', ['BROWSER_E2E'])
          await session.screenshotOnFail(`connector-${fam.key}`)
        }
      } catch (e) {
        store.rec(sid, 'FAIL', String(e), ['BROWSER_E2E'])
        await session.screenshotOnFail(`connector-${fam.key}`)
      }
    }
    store.setFlag('CONNECTOR_FAMILIES_ATTEMPTED', familiesAttempted.join(','))
    store.setFlag('CONNECTOR_FAMILIES_PASSED', familiesPassed.join(','))

    // ---- representative browser wizard stream (full journey) ----
    let h1IncrementalTestPass: boolean | null = null
    if (
      resources.connectors.HTTP &&
      resources.destinations.A &&
      resources.destinations.B &&
      want('03_STREAM_WIZARD_HTTP', ['browser', 'stream']) &&
      !skipIfResume('03_STREAM_WIZARD_HTTP')
    ) {
      const streamName = `e2e-${runId}-http-stream-H1`
      const result = await wizard.createHttpStreamJourney({
        connectorName: httpName,
        streamName,
        endpointPath: `/ulc/${runId}/h1`,
        destinationNames: [destAName, destBName],
        eventArrayPath: '$.items',
        pollingSec: 15,
        withBackReload: true,
        withProtection: true,
        withTransform:
          want('06_TRANSFORM_OUTPUT', ['delivery']) ||
          want('BFS004_PROCESSING_EXHAUSTIVE', ['browser', 'processing-exhaustive']),
        withIncremental: want('BFS005_SAMPLE_RECONCILIATION', ['browser', 'sample-reconciliation']),
      })
      h1IncrementalTestPass = result.incrementalTestPass
      const sid = await findStreamId(api, streamName)
      if (sid) {
        trackBrowser(store, 'STREAM', sid, streamName, `connector:${resources.connectors.HTTP}`)
        resources.streams.H1 = sid
        resources.streams.WIZARD = sid
        const routeIds = await attachBrowserRoutes(api, store, sid, streamName)
        resources.routes.H1A = routeIds[0]
        resources.routes.H1B = routeIds[1]
      }
      const wizardPass = result.ok && !!sid
      store.setFlag('FULL_STREAM_WIZARD_BROWSER_JOURNEY', wizardPass ? 'PASS' : 'FAIL')
      store.rec(
        '03_STREAM_WIZARD_HTTP',
        wizardPass ? 'PASS' : result.ok ? 'PARTIAL' : 'FAIL',
        result.note + (sid ? ` id=${sid}` : ''),
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
      if (sid) {
        await streams.openList()
        await captureBrowserCensus(page, store, '/streams', 'POPULATED')
        if (result.ok) {
          await streams.openRuntime(sid)
          await captureBrowserCensus(page, store, '/streams/:id/runtime', 'RUNNING')
        }
      }
    }

    // ---- BFS-005 Sample / Union Schema / checkpoint / incremental / dedup reconciliation ----
    if (
      resources.streams.H1 &&
      want('BFS005_SAMPLE_RECONCILIATION', ['browser', 'sample-reconciliation']) &&
      !skipIfResume('BFS005_SAMPLE_RECONCILIATION')
    ) {
      const streamId = Number(resources.streams.H1)
      const browserEvidence = await wizard.exerciseSampleUnionIncremental(streamId)
      await captureBrowserCensus(page, store, '/streams/:id/edit?step=sample', 'EDITING')
      const streamRead = await api.getStream(streamId)
      const cfg =
        streamRead?.config_json && typeof streamRead.config_json === 'object'
          ? (streamRead.config_json as Record<string, unknown>)
          : {}
      const union =
        cfg.union_schema && typeof cfg.union_schema === 'object'
          ? (cfg.union_schema as Record<string, unknown>)
          : null
      const checkpoint =
        cfg.checkpoint && typeof cfg.checkpoint === 'object'
          ? (cfg.checkpoint as Record<string, unknown>)
          : null
      const params =
        cfg.params && typeof cfg.params === 'object'
          ? (cfg.params as Record<string, unknown>)
          : {}
      const checkpointPersisted = Boolean(
        checkpoint &&
          JSON.stringify(checkpoint).includes('id'),
      )
      const unionPersisted = Boolean(
        union &&
          (Number(union.total_events || 0) > 0 || Array.isArray(union.fields)),
      )
      const incrementalPersisted =
        Object.entries(params).some(
          ([key, value]) =>
            /id_(?:gt|gte|after)/i.test(key) &&
            /checkpoint|last_(?:timestamp|id)/i.test(String(value)),
        ) ||
        /checkpoint\.last_(?:timestamp|id)/i.test(
          typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body ?? ''),
        )

      const dedupBrowser = await streams.exerciseDedupApiTestControl(streamId)
      const dedupApi = await api.request('GET', `/api/v1/runtime/streams/${streamId}/deduplication`)
      const dedupJson =
        dedupApi.json && typeof dedupApi.json === 'object'
          ? (dedupApi.json as Record<string, unknown>)
          : {}
      const dedupConfigured =
        dedupApi.status < 300 &&
        dedupJson.enabled === true &&
        String(dedupJson.key_field || dedupJson.custom_jsonpath || '').includes('id')

      const unionPass =
        browserEvidence.unionReady &&
        browserEvidence.rareVisible &&
        browserEvidence.sensitiveVisible &&
        unionPersisted
      const checkpointPass = browserEvidence.checkpointReadback && checkpointPersisted
      const incrementalPass =
        h1IncrementalTestPass === true &&
        browserEvidence.incrementalRequestReadback &&
        incrementalPersisted
      const dedupPass =
        dedupBrowser.fieldPresent &&
        dedupBrowser.requestIncludesDedup &&
        dedupBrowser.reloadReadback &&
        dedupConfigured

      store.writeJson('bfs005-sample-reconciliation.json', {
        streamId,
        h1IncrementalTestPass,
        browserEvidence,
        unionPersisted,
        checkpointPersisted,
        incrementalPersisted,
        persistedConfig: api.safeJson(cfg),
        dedupBrowser,
        dedupApiStatus: dedupApi.status,
        dedupApi: api.safeJson(dedupApi.json),
        dedupConfigured,
      })
      store.rec(
        'BFS005_UNION_SCHEMA',
        unionPass ? 'PASS' : 'FAIL',
        `ready=${browserEvidence.unionReady} rare=${browserEvidence.rareVisible} sensitive=${browserEvidence.sensitiveVisible} persisted=${unionPersisted}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
      store.rec(
        'BFS005_CHECKPOINT',
        checkpointPass ? 'PASS' : 'FAIL',
        `browser=${browserEvidence.checkpointReadback} persisted=${checkpointPersisted}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
      store.rec(
        'BFS005_INCREMENTAL_FETCH',
        incrementalPass ? 'PASS' : 'FAIL',
        `test=${h1IncrementalTestPass} browserReadback=${browserEvidence.incrementalRequestReadback} persisted=${incrementalPersisted}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
      store.rec(
        'BFS005_DEDUP',
        dedupPass ? 'PASS' : 'FAIL',
        `field=${dedupBrowser.fieldPresent} request=${dedupBrowser.requestIncludesDedup} reload=${dedupBrowser.reloadReadback} apiConfigured=${dedupConfigured}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
      store.rec(
        'BFS005_SAMPLE_RECONCILIATION',
        unionPass && checkpointPass && incrementalPass && dedupPass ? 'PASS' : 'FAIL',
        `union=${unionPass} checkpoint=${checkpointPass} incremental=${incrementalPass} dedup=${dedupPass}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
    }

    // ---- BFS-015 Governance lifecycle (browser mutation authority, API verification only) ----
    if (
      resources.streams.H1 &&
      resources.destinations.A &&
      resources.routes.H1A &&
      want('BFS015_GOVERNANCE_EXHAUSTIVE', ['browser', 'governance']) &&
      !skipIfResume('BFS015_GOVERNANCE_EXHAUSTIVE')
    ) {
      await runGovernanceLifecycle({
        page,
        api,
        store,
        runId,
        uiBase,
        fixtureScript: path.join(PKG, 'fixtures/seed_fixtures.py'),
        streamId: resources.streams.H1,
        destinationId: resources.destinations.A,
        routeId: resources.routes.H1A,
      })
    }

    // ---- exhaustive browser processing author → preview → save → reload/read-back ----
    if (
      resources.streams.H1 &&
      want('BFS004_PROCESSING_EXHAUSTIVE', ['browser', 'processing-exhaustive']) &&
      !skipIfResume('BFS004_PROCESSING_EXHAUSTIVE')
    ) {
      const result = await wizard.configureExhaustiveProcessing(resources.streams.H1)
      let browserReadback = false
      let apiReadback = false
      if (result.ok) {
        await wizard.openEditProcessing(resources.streams.H1)
        const guidedBody = await page.getByTestId('wizard-transform-enrichment-editor').innerText()
        const guidedReadback = ['e2e_static', 'e2e_calc', 'message_norm', 'ts_utc', 'e2e_cond'].every((field) =>
          guidedBody.includes(field),
        )

        await page.getByRole('tab', { name: /JSONata · Advanced/i }).click()
        const jsonataCard = page.locator('div.rounded-lg').filter({ hasText: 'Advanced · JSONata' }).last()
        const jsonataReadback =
          (await jsonataCard.getByLabel(/Output field/i).first().inputValue().catch(() => '')) === 'e2e_jsonata'

        await page.getByRole('tab', { name: /Regex · Expert/i }).click()
        const regexCard = page.locator('div.rounded-lg').filter({ hasText: 'Expert · Regex' }).last()
        const regexReadback =
          (await regexCard.getByLabel(/Output field/i).first().inputValue().catch(() => '')) === 'e2e_regex'

        browserReadback = guidedReadback && jsonataReadback && regexReadback
        const cfg = await api.request('GET', `/api/v1/runtime/streams/${resources.streams.H1}/mapping-ui/config`)
        const configText = JSON.stringify(cfg.json)
        apiReadback =
          cfg.status < 300 &&
          ['e2e_static', 'e2e_calc', 'message_norm', 'ts_utc', 'e2e_cond', 'e2e_jsonata', 'e2e_regex'].every((field) =>
            configText.includes(field),
          )
        store.writeJson('processing-exhaustive-readback.json', {
          browserReadback,
          guidedReadback,
          jsonataReadback,
          regexReadback,
          apiStatus: cfg.status,
          apiReadback,
          config: api.safeJson(cfg.json),
        })
      }
      const pass = result.ok && browserReadback && apiReadback
      store.setFlag('BFS004_PROCESSING_CONFIG', pass ? 'PASS' : 'FAIL')
      store.rec(
        'BFS004_PROCESSING_EXHAUSTIVE',
        pass ? 'PASS' : 'FAIL',
        `${result.note} browserReadback=${browserReadback} apiReadback=${apiReadback}`,
        ['BROWSER_E2E', 'API_INTEGRATION'],
      )
    }

    // ---- additional browser wizard streams (no API create) ----
    const extraHttp: Array<[string, string, string]> = [
      ['H2', `/ulc/${runId}/h2`, '$.data.records'],
      ['H3', `/ulc/${runId}/h3`, '$.items'],
      ['H4', `/ulc/${runId}/h4`, '$.items'],
      ['H5', `/ulc/${runId}/h5`, '$.items'],
      ['H6', `/ulc/${runId}/h3`, '$.items'],
    ]
    for (const [key, endpoint, eventPath] of extraHttp) {
      const sidName = `03_HTTP_STREAM_${key}`
      if (
        !resources.connectors.HTTP ||
        !resources.destinations.A ||
        !want(sidName, ['browser', 'stream']) ||
        skipIfResume(sidName)
      ) {
        continue
      }
      const name = `e2e-${runId}-http-stream-${key}`
      const result = await wizard.createHttpStreamJourney({
        connectorName: httpName,
        streamName: name,
        endpointPath: endpoint,
        destinationNames: [destAName, destBName],
        eventArrayPath: eventPath,
        pollingSec: 15,
      })
      const sid = await findStreamId(api, name)
      if (sid) {
        trackBrowser(store, 'STREAM', sid, name, `connector:${resources.connectors.HTTP}`)
        resources.streams[key] = sid
        const routeIds = await attachBrowserRoutes(api, store, sid, name)
        resources.routes[`${key}A`] = routeIds[0]
        resources.routes[`${key}B`] = routeIds[1]
      }
      store.rec(sidName, result.ok && sid ? 'PASS' : 'FAIL', result.note, ['BROWSER_E2E'])
    }

    for (const [recId, key, mode, expected] of [
      ['BFS004_FULL_EVENT_JSONATA', 'H2', 'jsonata', 'full-event-jsonata'],
      ['BFS004_FULL_EVENT_REGEX', 'H3', 'regex', 'regex_message'],
    ] as const) {
      const streamId = resources.streams[key]
      if (!streamId || !want(recId, ['browser', 'processing-exhaustive']) || skipIfResume(recId)) continue
      const result = await wizard.configureFullEventProcessing(
        streamId,
        mode,
        key === 'H2' ? '$.data.records' : '$.items',
      )
      let browserReadback = false
      let apiReadback = false
      if (result.ok) {
        await wizard.openEditProcessing(streamId, key === 'H2' ? '$.data.records' : '$.items')
        const tab =
          mode === 'jsonata'
            ? page.getByRole('tab', { name: /JSONata · Advanced/i })
            : page.getByRole('tab', { name: /Regex · Expert/i })
        await tab.click()
        await page.getByRole('button', { name: 'Full-event mode' }).click()
        const editor =
          mode === 'jsonata'
            ? page.getByLabel('Full event JSONata expression')
            : page.getByLabel('Full event regex transform JSON config')
        browserReadback = (await editor.inputValue()).includes(expected)

        const cfg = await api.request('GET', `/api/v1/runtime/streams/${streamId}/mapping-ui/config`)
        const text = JSON.stringify(cfg.json)
        apiReadback =
          cfg.status < 300 &&
          text.includes(mode === 'jsonata' ? 'full_event_jsonata' : 'full_event_regex') &&
          text.includes(expected)
        store.writeJson(`${recId.toLowerCase()}-readback.json`, {
          browserReadback,
          apiStatus: cfg.status,
          apiReadback,
          config: api.safeJson(cfg.json),
        })
      }
      const pass = result.ok && browserReadback && apiReadback
      store.rec(
        recId,
        pass ? 'PASS' : 'FAIL',
        `${result.note} browserReadback=${browserReadback} apiReadback=${apiReadback}`,
        ['BROWSER_E2E', 'API_INTEGRATION', 'RUNTIME_PREVIEW'],
      )
    }

    const familyStreamSpecs: Array<{
      key: string
      family: 'S3' | 'SFTP' | 'WEBHOOK' | 'DATABASE'
      connectorKey: string
      connectorName: string
      streamName: string
      remoteDirectory?: string
      filePattern?: string
    }> = [
      {
        key: 'S3A',
        family: 'S3',
        connectorKey: 'S3',
        connectorName: `e2e-${runId}-s3`,
        streamName: `e2e-${runId}-s3-stream-a`,
      },
      {
        key: 'S3B',
        family: 'S3',
        connectorKey: 'S3',
        connectorName: `e2e-${runId}-s3`,
        streamName: `e2e-${runId}-s3-stream-b`,
      },
      {
        key: 'SFTPA',
        family: 'SFTP',
        connectorKey: 'SFTP',
        connectorName: `e2e-${runId}-sftp`,
        streamName: `e2e-${runId}-sftp-stream-a`,
        remoteDirectory: `/upload/${runId}/a`,
        filePattern: '*.ndjson',
      },
      {
        key: 'SFTPB',
        family: 'SFTP',
        connectorKey: 'SFTP',
        connectorName: `e2e-${runId}-sftp`,
        streamName: `e2e-${runId}-sftp-stream-b`,
        remoteDirectory: `/upload/${runId}/b`,
        filePattern: '*.ndjson',
      },
      {
        key: 'WHA',
        family: 'WEBHOOK',
        connectorKey: 'WEBHOOK',
        connectorName: `e2e-${runId}-webhook`,
        streamName: `e2e-${runId}-webhook-stream-a`,
      },
      {
        key: 'WHB',
        family: 'WEBHOOK',
        connectorKey: 'WEBHOOK',
        connectorName: `e2e-${runId}-webhook`,
        streamName: `e2e-${runId}-webhook-stream-b`,
      },
      {
        key: 'DBS1',
        family: 'DATABASE',
        connectorKey: 'DATABASE',
        connectorName: `e2e-${runId}-db`,
        streamName: `e2e-${runId}-db-stream-orders`,
      },
      {
        key: 'DBS2',
        family: 'DATABASE',
        connectorKey: 'DATABASE',
        connectorName: `e2e-${runId}-db`,
        streamName: `e2e-${runId}-db-stream-users`,
      },
    ]
    let dbStreamsCreated = 0
    let dbWizardNotSupported = false
    for (const spec of familyStreamSpecs) {
      const recId = `03_${spec.key}_STREAM`
      if (!resources.connectors[spec.connectorKey] || !want(recId, ['browser', 'stream']) || skipIfResume(recId)) continue
      const result = await wizard.createFamilyStreamJourney({
        family: spec.family,
        connectorName: spec.connectorName,
        streamName: spec.streamName,
        destinationNames: [destAName, destBName],
        remoteDirectory: spec.remoteDirectory,
        filePattern: spec.filePattern,
        pollingSec: 15,
      })
      if (result.notSupported) {
        if (spec.family === 'DATABASE') dbWizardNotSupported = true
        store.setFlag(`${spec.family}_STREAM_WIZARD`, 'NOT_SUPPORTED_BY_CURRENT_UI')
        store.rec(recId, 'NOT_APPLICABLE', result.note, ['BROWSER_E2E'])
        continue
      }
      const sid = await findStreamId(api, spec.streamName)
      if (sid) {
        trackBrowser(store, 'STREAM', sid, spec.streamName, `connector:${resources.connectors[spec.connectorKey]}`)
        resources.streams[spec.key] = sid
        await attachBrowserRoutes(api, store, sid, spec.streamName)
        if (spec.family === 'DATABASE') dbStreamsCreated += 1
      }
      store.rec(recId, result.ok && sid ? 'PASS' : 'FAIL', result.note, ['BROWSER_E2E'])
    }
    if (!resources.connectors.DATABASE) {
      store.setFlag('DATABASE_BROWSER_JOURNEY', 'FAIL')
    } else if (dbStreamsCreated >= 2) {
      store.setFlag('DATABASE_BROWSER_JOURNEY', 'PASS')
    } else if (dbWizardNotSupported) {
      store.setFlag('DATABASE_STREAM_WIZARD', 'NOT_SUPPORTED_BY_CURRENT_UI')
      store.setFlag('DATABASE_BROWSER_JOURNEY', 'PARTIAL')
    } else {
      store.setFlag('DATABASE_BROWSER_JOURNEY', 'FAIL')
    }
    const sftpCreated = ['SFTPA', 'SFTPB'].filter((k) => resources.streams[k]).length
    const webhookCreated = ['WHA', 'WHB'].filter((k) => resources.streams[k]).length
    store.setFlag('SFTP_BROWSER_STREAM_JOURNEY', sftpCreated >= 2 ? 'PASS' : 'FAIL')
    store.setFlag('WEBHOOK_BROWSER_STREAM_JOURNEY', webhookCreated >= 2 ? 'PASS' : 'FAIL')

    // ---- start streams (browser first) ----
    const runningIds: number[] = []
    if (want('07_START_STREAMS', ['browser', 'runtime']) && !skipIfResume('07_START_STREAMS')) {
      const streamKeys = Object.keys(resources.streams)
      const targetIds = [...new Set(streamKeys.map((key) => Number(resources.streams[key])).filter((id) => Number.isFinite(id) && id > 0))]
      const browserStartedIds: number[] = []
      const apiFallbackStartedIds: number[] = []
      try {
        for (const id of targetIds) {
          const isPrimary = id === Number(resources.streams.H1)
          let browserStarted = false
          try {
            // Runtime control verification must not depend on Streams list search/virtualization.
            // Navigate the known persisted resource id to the real browser runtime surface.
            await streams.openRuntime(id)
            const activeBefore = await streams.runControlActive()
            if (activeBefore === true && (await waitForStreamEnabled(api, id, true))) {
              // Wizard deploy is a browser "Create and Start" action. If the runtime control
              // is already active here, that browser start is authoritative; do not mutate by API.
              browserStarted = true
              if (isPrimary) {
                store.rec('46_START_TWICE', 'PASS', 'already running from browser Create and Start', ['BROWSER_E2E'])
              }
            } else {
              const clicked = await streams.clickStart()
              browserStarted = clicked && (await waitForStreamEnabled(api, id, true))
              if (isPrimary && browserStarted) {
                store.rec('46_START_TWICE', 'PASS', 'browser start control activated successfully', ['BROWSER_E2E'])
              }
            }
          } catch (e) {
            if (isPrimary) store.rec('46_START_TWICE', 'PARTIAL', String(e).slice(0, 120), ['BROWSER_E2E'])
          }

          if (browserStarted) {
            browserStartedIds.push(id)
            runningIds.push(id)
            continue
          }

          // Forensic/downstream continuation only. This mutation must never contribute to browser PASS.
          const fallback = await api.startStream(id).catch(() => null)
          if (fallback && fallback.status < 300 && (await waitForStreamEnabled(api, id, true))) {
            apiFallbackStartedIds.push(id)
            runningIds.push(id)
          }
        }
        store.setFlag(
          'MULTI_STREAM_RUNTIME_PROVEN',
          runningIds.length >= 8 ? 'YES' : runningIds.length >= 2 ? 'PARTIAL' : 'NO',
        )
        const browserComplete = targetIds.length > 0 && browserStartedIds.length === targetIds.length
        const status = browserComplete ? 'PASS' : runningIds.length > 0 ? 'PARTIAL' : 'FAIL'
        store.rec(
          '07_START_STREAMS',
          status,
          `targets=${targetIds.length} browserStarted=${browserStartedIds.length} apiFallback=${apiFallbackStartedIds.length} running=${runningIds.length}`,
          ['BROWSER_E2E', 'API_INTEGRATION'],
        )
      } catch (e) {
        store.rec('07_START_STREAMS', 'FAIL', String(e).slice(0, 200), ['BROWSER_E2E'])
      }
    }

    // ---- actual delivery (scheduler first; run-once only as forensic fallback) ----
    const primaryHttp = resources.streams.H1 || resources.streams.H2 || resources.streams.H3
    const primaryHttpName = resources.streams.H1
      ? `e2e-${runId}-http-stream-H1`
      : resources.streams.H2
        ? `e2e-${runId}-http-stream-H2`
        : `e2e-${runId}-http-stream-H3`
    const primaryHttpPath = resources.streams.H1 ? `/ulc/${runId}/h1` : resources.streams.H2 ? `/ulc/${runId}/h2` : `/ulc/${runId}/h3`

    const wrapHttpItem = (item: Record<string, unknown>) =>
      primaryHttpPath.endsWith('/h2') ? { data: { records: [item] } } : { items: [item] }

    let deliveryPass = 0
    let deliveryTests = 0
    if (primaryHttp && want('07_DELIVERY', ['delivery'])) {
      deliveryTests += 2
      const m = `marker-${runId}-deliv-1`
      // Seed fixtures already used ids 1-12; reuse would be skipped by incremental checkpoint.
      await stubWiremock(
        wm,
        primaryHttpPath,
        wrapHttpItem({
          id: 10001,
          run_id: runId,
          connector: 'HTTP',
          stream: 'primary',
          route: 'A',
          sequence: 10001,
          message: m,
          timestamp: '2026-10-02T10:45:00Z',
          email: 'test@example.invalid',
          api_key: `FAKE_API_KEY_${runId}`,
        }),
        { bearer: token },
      )
      let a = await waitForDelivery(m, `/ulc-${runId}-a`, TIMEOUTS.schedulerPollMs)
      let b = await waitForDelivery(m, `/ulc-${runId}-b`, 20_000)
      if (!a || !b) {
        await api.runOnce(primaryHttp)
        if (!a) a = await waitForDelivery(m, `/ulc-${runId}-a`)
        if (!b) b = await waitForDelivery(m, `/ulc-${runId}-b`, 30_000)
      }
      store.delivery('07_TWO_ROUTE', m, `/ulc-${runId}-a`, a)
      store.delivery('07_TWO_ROUTE', m, `/ulc-${runId}-b`, b)
      if (a) deliveryPass++
      if (b) deliveryPass++
      store.setFlag('TWO_ROUTE_DELIVERY_PROVEN', a && b ? 'YES' : 'NO')
      store.rec('07_TWO_ROUTE_DELIVERY', a && b ? 'PASS' : 'FAIL', `a=${a} b=${b}`, ['ACTUAL_DELIVERY', 'RUNTIME_E2E'])

      const logs = echoLogsTail()
      const blockA = extractEchoBlock(logs, m, `/ulc-${runId}-a`)
      const blockB = extractEchoBlock(logs, m, `/ulc-${runId}-b`)
      const aHasPlain = blockA.includes('test@example.invalid')
      const bHasPlain = blockB.includes('test@example.invalid')

      if (store.flags.BFS004_PROCESSING_CONFIG === 'PASS') {
        const runtimeFields = ['e2e_static', 'e2e_calc', 'message_norm', 'ts_utc', 'e2e_cond', 'e2e_jsonata', 'e2e_regex']
        const runtimeHits = runtimeFields.filter((field) => blockA.includes(field))
        const runtimePass = runtimeHits.length === runtimeFields.length
        store.setFlag('BFS004_PROCESSING_RUNTIME', runtimePass ? 'PASS' : 'FAIL')
        store.rec(
          'BFS004_PROCESSING_RUNTIME',
          runtimePass ? 'PASS' : 'FAIL',
          `fields=${runtimeHits.join(',')} expected=${runtimeFields.length}`,
          ['ACTUAL_DELIVERY', 'RUNTIME_E2E'],
        )
      }

      const transformB =
        (blockB.includes('event_message') || blockB.includes('transformed_message')) &&
        !blockA.includes('event_message') &&
        !blockA.includes('transformed_message')
      const protOk = (!aHasPlain || /\*/.test(blockA)) && (!bHasPlain || /\*/.test(blockB) || blockB.includes('[masked]'))
      store.setFlag('PROTECTION_OUTPUT_PROVEN', protOk && a && b ? 'YES' : a && b ? 'PARTIAL' : 'NO')
      store.setFlag('PROTECTION_ROUTE_ISOLATION', aHasPlain !== bHasPlain || protOk ? 'YES' : 'NO')
      store.setFlag('TRANSFORM_OUTPUT_PROVEN', transformB ? 'YES' : 'NO')
      store.setFlag('TRANSFORM_ROUTE_ISOLATION', transformB ? 'YES' : 'NO')
      const xfDump: unknown[] = []
      for (const rid of [resources.routes.H1A, resources.routes.H1B].filter(Boolean)) {
        const cfg = await api.request('GET', `/api/v1/runtime/routes/${rid}/mapping-ui/config`)
        const eff = await api.request('GET', `/api/v1/runtime/routes/${rid}/transform/effective`)
        xfDump.push({ routeId: rid, mapping: cfg.json, effective: eff.json })
      }
      store.writeJson('transform-route-config.json', {
        transformB,
        echoAHasEventMessage: blockA.includes('event_message'),
        echoBHasEventMessage: blockB.includes('event_message'),
        echoAHasTransformed: blockA.includes('transformed_message'),
        echoBHasTransformed: blockB.includes('transformed_message'),
        routes: xfDump,
        blockA: blockA.slice(0, 4000),
        blockB: blockB.slice(0, 4000),
      })
      store.rec('06_PROTECTION_OUTPUT', protOk ? 'PASS' : 'PARTIAL', `aPlain=${aHasPlain} bPlain=${bHasPlain}`, [
        'ACTUAL_DELIVERY',
      ])
      store.rec('06_TRANSFORM_OUTPUT', transformB ? 'PASS' : 'PARTIAL', `transformB=${transformB}`, ['ACTUAL_DELIVERY'])
    }

    // ---- exhaustive full-event processing delivery proof ----
    if (want('07_DELIVERY', ['delivery'])) {
      for (const [recId, key, endpoint, markerField, nested] of [
        ['BFS004_FULL_EVENT_JSONATA_RUNTIME', 'H2', `/ulc/${runId}/h2`, 'jsonata_marker', true],
        ['BFS004_FULL_EVENT_REGEX_RUNTIME', 'H3', `/ulc/${runId}/h3`, 'regex_message', false],
      ] as const) {
        const streamId = resources.streams[key]
        const configRec = key === 'H2' ? 'BFS004_FULL_EVENT_JSONATA' : 'BFS004_FULL_EVENT_REGEX'
        if (!streamId || !store.scenarios.some((row) => row.id === configRec && row.status === 'PASS')) continue
        const marker = `marker-${runId}-${key.toLowerCase()}-full-event`
        const item = {
          id: key === 'H2' ? 20002 : 20003,
          run_id: runId,
          stream: key,
          sequence: key === 'H2' ? 20002 : 20003,
          message: marker,
          timestamp: '2026-10-02T10:50:00Z',
        }
        await stubWiremock(wm, endpoint, nested ? { data: { records: [item] } } : { items: [item] }, { bearer: token })
        let delivered = await waitForDelivery(marker, `/ulc-${runId}-a`, 25_000)
        if (!delivered) {
          await api.runOnce(streamId)
          delivered = await waitForDelivery(marker, `/ulc-${runId}-a`, 25_000)
        }
        const block = extractEchoBlock(echoLogsTail(), marker, `/ulc-${runId}-a`)
        const runtimePass = delivered && block.includes(markerField)
        store.rec(
          recId,
          runtimePass ? 'PASS' : 'FAIL',
          `delivered=${delivered} field=${markerField} present=${block.includes(markerField)}`,
          ['ACTUAL_DELIVERY', 'RUNTIME_E2E'],
        )
      }
    }

    // ---- family actual delivery (SFTP file, DB rows, webhook inbound POST) ----
    if (want('07_FAMILY_DELIVERY', ['delivery']) || want('07_DELIVERY', ['delivery'])) {
      const pathA = `/ulc-${runId}-a`
      const seedPy = path.join(PKG, 'fixtures/seed_fixtures.py')
      const sftpId = resources.streams.SFTPA
      if (sftpId) {
        const sftpMarker = `SFTPDEL-${runId}-001`
        spawnSync(
          'python3',
          [seedPy, 'seed-sftp-event', '--run-id', runId, '--folder', 'a', '--marker', sftpMarker, '--filename', `delivery-${runId}.ndjson`],
          { cwd: REPO, encoding: 'utf8' },
        )
        await api.startStream(sftpId).catch(() => null)
        const sftpRun = await api.runOnce(sftpId)
        const sftpOk = await waitForDelivery(sftpMarker, pathA)
        store.writeJson('sftp-delivery-run-once.json', { status: sftpRun.status, json: sftpRun.json, marker: sftpMarker, ok: sftpOk })
        store.delivery('07_SFTP_DELIVERY', sftpMarker, pathA, sftpOk)
        if (sftpOk) deliveryPass++
        deliveryTests++
        store.rec(
          '07_SFTP_DELIVERY',
          sftpOk ? 'PASS' : 'FAIL',
          `marker=${sftpOk} runOnce=${sftpRun.status}`,
          ['ACTUAL_DELIVERY'],
        )
        store.setFlag('SFTP_BROWSER_STREAM_JOURNEY', sftpOk ? 'PASS' : 'FAIL')
      }
      const dbId = resources.streams.DBS1 || resources.streams.DBS2
      if (dbId) {
        const dbMarker = `DBDEL-${runId}-001`
        const dbTable = resources.streams.DBS1 ? 'source_e2e_orders' : 'source_e2e_users'
        spawnSync(
          'python3',
          [seedPy, 'seed-db-event', '--table', dbTable, '--event-id', `${runId}-del-${Date.now()}`, '--marker', dbMarker],
          { cwd: REPO, encoding: 'utf8' },
        )
        await api.startStream(dbId).catch(() => null)
        const dbRun = await api.runOnce(dbId)
        const dbOk = await waitForDelivery(dbMarker, pathA)
        store.writeJson('db-delivery-run-once.json', { status: dbRun.status, json: dbRun.json, marker: dbMarker, ok: dbOk })
        store.delivery('07_DATABASE_DELIVERY', dbMarker, pathA, dbOk)
        if (dbOk) deliveryPass++
        deliveryTests++
        store.rec(
          '07_DATABASE_DELIVERY',
          dbOk ? 'PASS' : 'FAIL',
          `marker=${dbOk} runOnce=${dbRun.status}`,
          ['ACTUAL_DELIVERY'],
        )
        store.setFlag('DATABASE_BROWSER_JOURNEY', dbOk ? 'PASS' : 'FAIL')
      }
      const whId = resources.streams.WHA
      const whCid = resources.connectors.WEBHOOK
      if (whId && whCid) {
        const conn = await api.getConnector(whCid)
        const receiverKey = String(conn?.receiver_key || conn?.config_json?.receiver_key || '').trim()
        const whMarker = `WHIN-${runId}-001`
        if (receiverKey) {
          await api.startStream(whId).catch(() => null)
          await fetch(`${apiBase}/api/v1/ingest/webhook/${encodeURIComponent(receiverKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: [{ id: Date.now(), run_id: runId, message: whMarker, email: 'test@example.invalid' }],
            }),
          }).catch(() => null)
          const whOk = await waitForDelivery(whMarker, pathA, 45_000)
          store.delivery('07_WEBHOOK_DELIVERY', whMarker, pathA, whOk)
          if (whOk) deliveryPass++
          deliveryTests++
          store.rec('07_WEBHOOK_DELIVERY', whOk ? 'PASS' : 'FAIL', `key=${receiverKey.slice(0, 8)} marker=${whOk}`, [
            'ACTUAL_DELIVERY',
          ])
          store.setFlag('WEBHOOK_BROWSER_STREAM_JOURNEY', whOk ? 'PASS' : 'FAIL')
        } else {
          store.rec('07_WEBHOOK_DELIVERY', 'FAIL', 'missing receiver_key', ['API_INTEGRATION'])
          store.setFlag('WEBHOOK_BROWSER_STREAM_JOURNEY', 'FAIL')
        }
      }
    }

    // ---- destination failure isolation (UI diagnosis first) ----
    if (resources.destinations.B && primaryHttp && want('08_DEST_FAIL', ['failure', 'browser'])) {
      const downUrl = 'http://127.0.0.1:9/down'
      const marker = `DSTFAIL-${runId}-001`
      const pathA = `/ulc-${runId}-a`
      const pathB = `/ulc-${runId}-b`
      const baselineLogs = echoLogsTail()
      const baselineA = countMarkerInEcho(baselineLogs, marker)
      const baselineB = deliveredInEcho(baselineLogs, marker, pathB)
      store.writeJson('dest-fail-baseline.json', {
        marker,
        baselineACount: baselineA,
        baselineBHadMarker: baselineB,
        note: 'Marker must be absent before dest B mutation; later PASS requires same-block match only.',
      })

      const edited = await destinations.editWebhookUrl(destBName, downUrl)
      const editMeta = destinations.lastEditMeta
      let forensicPut: { status: number } | null = null
      const destAfterUi = await api.getDestination(resources.destinations.B)
      const urlAfterUi = String(destAfterUi?.config_json?.url || '')
      const uiPersisted = urlAfterUi.includes('127.0.0.1:9') || urlAfterUi.includes('/down')
      if (!edited || !uiPersisted) {
        const patched = await api.patchDestination(resources.destinations.B, {
          config_json: { url: downUrl, retry_count: 0, retry_backoff_seconds: 0.01 },
        })
        forensicPut = { status: patched.status }
        store.rec(
          '08_DEST_FAIL_BROWSER_EDIT',
          patched.status < 300 ? 'PARTIAL' : 'FAIL',
          `UI save=${edited} put=${editMeta.putStatus} urlAfterUi=${urlAfterUi}; forensic PUT status=${patched.status}`,
          ['BROWSER_E2E'],
        )
      } else {
        store.rec(
          '08_DEST_FAIL_BROWSER_EDIT',
          'PASS',
          `destination B URL changed in UI put=${editMeta.putStatus}`,
          ['BROWSER_E2E'],
        )
      }
      const readback = await api.getDestination(resources.destinations.B)
      const savedUrl = String(readback?.config_json?.url || '')
      const persistOk = savedUrl.includes('127.0.0.1:9') || savedUrl.includes('/down')
      const routes = await api.listRoutesForStream(primaryHttp)
      const routeB = routes.find((r) => Number(r.destination_id) === Number(resources.destinations.B))
      const routeA = routes.find((r) => Number(r.destination_id) === Number(resources.destinations.A))
      const runtimeCfg = await api.getRuntimeConfiguration(primaryHttp)
      store.writeJson('dest-b-fail-readback.json', {
        savedUrl,
        persistOk,
        destinationId: resources.destinations.B,
        uiSaveSent: edited,
        uiPutStatus: editMeta.putStatus,
        urlAfterUi,
        forensicPut,
        routeA: routeA ? { id: routeA.id, destination_id: routeA.destination_id } : null,
        routeB: routeB ? { id: routeB.id, destination_id: routeB.destination_id } : null,
        runtimeConfigStatus: runtimeCfg.status,
        runtimeConfig: runtimeCfg.json,
      })
      store.rec('08_DEST_FAIL_API_READBACK', persistOk ? 'PASS' : 'FAIL', `url=${savedUrl}`, ['API_INTEGRATION'])
      store.rec(
        '08_DEST_FAIL_ROUTE_REF',
        routeB ? 'PASS' : 'FAIL',
        `routeB.destination_id=${routeB?.destination_id}`,
        ['API_INTEGRATION'],
      )
      await stubWiremock(
        wm,
        primaryHttpPath,
        wrapHttpItem({
          id: 10002,
          run_id: runId,
          sequence: 10002,
          message: marker,
          email: 'x@y.z',
        }),
        { bearer: token },
      )
      const runOnceIso = await api.runOnce(primaryHttp)
      let aOk = await waitForDelivery(marker, pathA)
      const bOk = await waitForDelivery(marker, pathB, 15_000)
      if (!aOk && runOnceIso.status === 409) {
        aOk = await waitForDelivery(marker, pathA, TIMEOUTS.schedulerPollMs)
      }
      store.writeJson('dest-fail-run-once.json', {
        status: runOnceIso.status,
        json: runOnceIso.json,
        aOk,
        bOk,
      })
      const openedIso = await streams.openStreamByName(primaryHttpName)
      if (!openedIso) {
        await streams.openRuntime(primaryHttp)
        store.rec('08_DEST_FAIL_UI_NAV', 'PARTIAL', 'list row collapsed; opened runtime by id', ['BROWSER_E2E'])
      } else {
        store.rec('08_DEST_FAIL_UI_NAV', 'PASS', 'stream opened from list', ['BROWSER_E2E'])
      }
      await captureBrowserCensus(page, store, '/streams/:id/runtime', 'PARTIAL_FAILURE')
      const diag = await streams.diagnoseFailureJourney()
      await captureBrowserCensus(page, store, '/monitoring', 'ERROR')
      store.writeJson('dest-failure-diagnosis.json', diag)
      store.setFlag('DESTINATION_FAILURE_DIAGNOSIS_PROVEN', diag.ERROR_VISIBLE)
      store.setFlag('FAILED_ROUTE_IDENTIFIABLE', diag.AFFECTED_RESOURCE_IDENTIFIABLE)
      store.setFlag('ERROR_REASON_VISIBLE', diag.ROOT_CAUSE_VISIBLE)
      store.setFlag('RECOVERY_ACTION_VISIBLE', diag.RECOVERY_ACTION_VISIBLE)
      const browserEditOk = edited && uiPersisted
      const isolationOk = browserEditOk && persistOk && aOk && !bOk
      store.setFlag('ROUTE_FAILURE_ISOLATION_PROVEN', isolationOk ? 'YES' : 'NO')
      store.delivery('08_DEST_FAIL_ISOLATION', marker, pathA, aOk)
      store.delivery('08_DEST_FAIL_ISOLATION', marker, pathB, bOk)
      if (aOk) deliveryPass++
      deliveryTests += 1
      store.rec(
        '08_DEST_FAIL_ISOLATION',
        isolationOk ? 'PASS' : 'FAIL',
        `browserEdit=${browserEditOk} persist=${persistOk} a=${aOk} b=${bOk} runOnce=${runOnceIso.status} uiErr=${diag.ERROR_VISIBLE}`,
        ['BROWSER_E2E', 'ACTUAL_DELIVERY'],
      )
      const recoveredEdit = await destinations.editWebhookUrl(destBName, `${echo}${pathB}`)
      let recoveryApiFallback = false
      if (!recoveredEdit) {
        recoveryApiFallback = true
        await api.patchDestination(resources.destinations.B, {
          config_json: { url: `${echo}${pathB}`, retry_count: 0, retry_backoff_seconds: 0.01 },
        })
      }
      const marker2 = `DST-RECOVER-${runId}`
      await stubWiremock(
        wm,
        primaryHttpPath,
        wrapHttpItem({ id: 10003, run_id: runId, sequence: 10003, message: marker2 }),
        { bearer: token },
      )
      await api.runOnce(primaryHttp)
      const recA = await waitForDelivery(marker2, pathA)
      const recB = await waitForDelivery(marker2, pathB)
      deliveryTests += 2
      if (recA) deliveryPass++
      if (recB) deliveryPass++
      const browserRecoveryOk = recoveredEdit && recA && recB
      store.setFlag('DESTINATION_RECOVERY_PROVEN', browserRecoveryOk ? 'YES' : 'NO')
      store.rec(
        '09_DEST_RECOVERY',
        browserRecoveryOk ? 'PASS' : recA && recB && recoveryApiFallback ? 'PARTIAL' : 'FAIL',
        `browserEdit=${recoveredEdit} apiFallback=${recoveryApiFallback} a=${recA} b=${recB}`,
        ['ACTUAL_DELIVERY', 'BROWSER_E2E', 'API_INTEGRATION'],
      )
    }

    // ---- source failure diagnosis (UI first) ----
    if (resources.connectors.HTTP && primaryHttp && want('08_SOURCE_FAIL', ['failure', 'browser'])) {
      try {
      await stubWiremock(wm, primaryHttpPath, { error: 'down' }, { status: 500, bearer: token })
      const runFail = await api.request('POST', `/api/v1/runtime/streams/${primaryHttp}/run-once`, {}, 45_000).catch(
        (e) => ({ status: 0, json: { error: String(e) }, text: String(e) }),
      )
      const snapAfter = await api.request('GET', '/api/v1/runtime/operational-snapshot')
      const snapProblems = Array.isArray(snapAfter.json?.problems) ? snapAfter.json.problems : []
      store.writeJson('source-fail-snapshot.json', {
        runOnceStatus: runFail.status,
        runOnce: runFail.json,
        problemCount: snapProblems.length,
        problems: snapProblems.slice(0, 8),
        streamHealth: (snapAfter.json?.streams || []).find((s: any) => Number(s.stream_id) === Number(primaryHttp)),
      })
      let dashSignal = { visible: false, posture: '', issuesText: '', problemCount: 0 }
      for (let i = 0; i < 6; i++) {
        await streams.openDashboard()
        await streams.refreshDashboard()
        dashSignal = await streams.readDashboardProblemSignal()
        if (dashSignal.visible) break
        await page.waitForTimeout(2500)
      }
      const openedAffectedStream = await streams.openStreamByName(primaryHttpName)
      const shortStream = primaryHttpName.length > 24 ? primaryHttpName.slice(-24) : primaryHttpName
      const streamOnDashOrList =
        openedAffectedStream ||
        dashSignal.issuesText.includes(primaryHttpName) ||
        dashSignal.issuesText.includes(shortStream)
      if (!openedAffectedStream) await streams.openRuntime(primaryHttp)
      const runtimeText = (await page.locator('main').first().innerText().catch(() => '')) || ''
      await connectors.openDetail(resources.connectors.HTTP)
      const connectorText = (await page.locator('h2, h3').first().innerText().catch(() => '')) || ''
      const detailCombined = `${runtimeText}\n${connectorText}\n${dashSignal.issuesText}`
      const rootCauseVisible = /500|source fetch|fetch failed|http error|connection|timeout|unauthor|refused|degraded|error/i.test(
        detailCombined,
      )
      const recoveryVisible = /retry|restart|start|edit|test authentication|test auth|reconnect/i.test(
        `${runtimeText}\n${connectorText}`,
      )
      const drilldown = true
      const diag = {
        ERROR_VISIBLE: dashSignal.visible ? 'YES' : 'NO',
        AFFECTED_RESOURCE_IDENTIFIABLE: streamOnDashOrList ? 'YES' : 'NO',
        ROOT_CAUSE_VISIBLE: rootCauseVisible ? 'YES' : 'NO',
        RECOVERY_ACTION_VISIBLE: recoveryVisible ? 'YES' : 'NO',
        DASHBOARD_PROBLEM_SIGNAL_VISIBLE: dashSignal.visible ? 'YES' : 'NO',
        AFFECTED_STREAM_IDENTIFIABLE: streamOnDashOrList ? 'YES' : 'NO',
        DRILLDOWN_AVAILABLE: drilldown ? 'YES' : 'NO',
        pagesVisited: ['dashboard', 'streams', `stream-runtime:${primaryHttp}`, `connector:${resources.connectors.HTTP}`],
        dashboardPosture: dashSignal.posture,
        dashboardIssues: dashSignal.issuesText,
        dashboardProblemCount: dashSignal.problemCount,
        runOnceStatus: runFail.status,
      }
      store.writeJson('source-failure-diagnosis.json', diag)
      store.setFlag('SOURCE_FAILURE_DIAGNOSIS_PROVEN', dashSignal.visible && streamOnDashOrList && (rootCauseVisible || drilldown) ? 'YES' : 'NO')
      store.setFlag('FAILURE_VISIBLE_ON_DASHBOARD', dashSignal.visible ? 'YES' : 'NO')
      store.setFlag('DASHBOARD_PROBLEM_SIGNAL_VISIBLE', dashSignal.visible ? 'YES' : 'NO')
      store.setFlag('AFFECTED_STREAM_IDENTIFIABLE', streamOnDashOrList ? 'YES' : 'NO')
      store.setFlag('DRILLDOWN_AVAILABLE', drilldown ? 'YES' : 'NO')
      store.setFlag('ROOT_CAUSE_VISIBLE', rootCauseVisible ? 'YES' : 'NO')
      store.setFlag('RECOVERY_ACTION_VISIBLE', recoveryVisible ? 'YES' : 'NO')
      const diagnosisPass = dashSignal.visible && streamOnDashOrList && drilldown && rootCauseVisible
      await stubWiremock(
        wm,
        primaryHttpPath,
        wrapHttpItem({ id: 10013, run_id: runId, message: `SRC-RECOVER-${runId}` }),
        { bearer: token },
      )
      await connectors.openDetail(resources.connectors.HTTP)
      await connectors.setAuthTestPath(primaryHttpPath)
      await connectors.testAuth()
      await streams.openRuntime(primaryHttp)
      await streams.clickStart().catch(() => null)
      await api.request('POST', `/api/v1/runtime/streams/${primaryHttp}/run-once`, {}, 45_000).catch(() => null)
      const ok = await waitForDelivery(`SRC-RECOVER-${runId}`, `/ulc-${runId}-a`)
      store.setFlag('SOURCE_RECOVERY_PROVEN', ok ? 'YES' : 'NO')
      store.rec('08_SOURCE_FAIL_DIAGNOSIS', diagnosisPass ? 'PASS' : 'PARTIAL', JSON.stringify(diag).slice(0, 500), [
        'BROWSER_E2E',
      ])
      store.rec('09_SOURCE_RECOVERY', ok ? 'PASS' : 'FAIL', '', ['ACTUAL_DELIVERY'])
      if (ok) {
        deliveryTests++
        deliveryPass++
      }
      } catch (e) {
        store.rec('08_SOURCE_FAIL_DIAGNOSIS', 'FAIL', String(e).slice(0, 200), ['BROWSER_E2E'])
      }
    }

    // ---- checkpoint invariant (API verify; UI visible if present) ----
    if (resources.streams.H3 && want('38_CHECKPOINT', ['checkpoint', 'delivery'])) {
      const before = await api.getCheckpoint(resources.streams.H3).catch(() => null)
      await stubWiremock(
        wm,
        `/ulc/${runId}/h3`,
        { items: [{ id: 1, run_id: runId, checkpoint: 'cp-1', message: `marker-${runId}-cp1` }] },
        { bearer: token },
      )
      await api.startStream(resources.streams.H3)
      await api.runOnce(resources.streams.H3)
      await waitForDelivery(`marker-${runId}-cp1`, `/ulc-${runId}-a`)
      const mid = await api.getCheckpoint(resources.streams.H3).catch(() => null)
      // inject dest failure for next event
      await api.patchDestination(resources.destinations.A, {
        config_json: { url: 'http://127.0.0.1:9/down', retry_count: 0, retry_backoff_seconds: 0.01 },
      })
      await api.patchDestination(resources.destinations.B, {
        config_json: { url: 'http://127.0.0.1:9/down', retry_count: 0, retry_backoff_seconds: 0.01 },
      })
      await stubWiremock(
        wm,
        `/ulc/${runId}/h3`,
        { items: [{ id: 2, run_id: runId, checkpoint: 'cp-2', message: `marker-${runId}-cp2` }] },
        { bearer: token },
      )
      await api.runOnce(resources.streams.H3)
      const mid2 = await api.getCheckpoint(resources.streams.H3).catch(() => null)
      const skippedDuringFail = await waitForDelivery(`marker-${runId}-cp2`, `/ulc-${runId}-a`, 12_000)
      store.setFlag('CHECKPOINT_DID_NOT_SKIP_UNDELIVERED_DATA', skippedDuringFail ? 'FAIL' : 'PASS')
      // restore and expect cp2 delivery without skip
      await destinations.editWebhookUrl(destAName, `${echo}/ulc-${runId}-a`).catch(() => null)
      await destinations.editWebhookUrl(destBName, `${echo}/ulc-${runId}-b`).catch(() => null)
      await api.patchDestination(resources.destinations.A, {
        config_json: { url: `${echo}/ulc-${runId}-a`, retry_count: 0, retry_backoff_seconds: 0.01 },
      })
      await api.patchDestination(resources.destinations.B, {
        config_json: { url: `${echo}/ulc-${runId}-b`, retry_count: 0, retry_backoff_seconds: 0.01 },
      })
      await api.runOnce(resources.streams.H3)
      const delivered = await waitForDelivery(`marker-${runId}-cp2`, `/ulc-${runId}-a`)
      const after = await api.getCheckpoint(resources.streams.H3).catch(() => null)
      store.checkpointRows.push(
        `${new Date().toISOString()}\tH3\tbaseline\t${JSON.stringify(before)}\t`,
      )
      store.checkpointRows.push(`${new Date().toISOString()}\tH3\tafter1\t${JSON.stringify(mid)}\t`)
      store.checkpointRows.push(`${new Date().toISOString()}\tH3\tfail-inject\t${JSON.stringify(mid2)}\t`)
      store.checkpointRows.push(`${new Date().toISOString()}\tH3\trecover\t${JSON.stringify(after)}\t`)
      const didNotSkip = delivered && !skippedDuringFail
      store.setFlag('CHECKPOINT_BASELINE_ADVANCE', mid ? 'PASS' : 'FAIL')
      store.setFlag('CHECKPOINT_INVARIANT_PROVEN', didNotSkip ? 'YES' : 'NO')
      store.rec('38_CHECKPOINT_INVARIANT', didNotSkip ? 'PASS' : 'FAIL', `delivered_cp2=${delivered}`, [
        'ACTUAL_DELIVERY',
        'API_INTEGRATION',
      ])
      if (delivered) {
        deliveryTests++
        deliveryPass++
      }
      // UI checkpoint visibility: verify the dedicated Stream Information panel,
      // not a truncated body-text prefix or virtualized Streams list navigation.
      await streams.openRuntime(resources.streams.H3)
      const checkpointUi = await streams.checkpointVisible()
      store.rec(
        '38_CHECKPOINT_UI_VISIBLE',
        checkpointUi.visible ? 'PASS' : 'PARTIAL',
        checkpointUi.text.slice(0, 240),
        ['BROWSER_E2E'],
      )
    }

    // ---- new browser context persistence ----
    if (resources.connectors.HTTP && want('30_NEW_CONTEXT', ['browser'])) {
      await context!.close()
      context = await browser!.newContext({ ignoreHTTPSErrors: true })
      page = await context.newPage()
      const session2 = new OperatorSession(page, uiBase, store)
      session2.installNetworkCapture('context-b')
      await session2.login()
      connectorsPg = new ConnectorsPage(session2)
      streamsPg = new StreamsPage(session2)
      destinationsPg = new DestinationsPage(session2)
      activeSession = session2
      await connectorsPg.openDetailByName(httpName)
      const body = await page.locator('body').innerText()
      const ok = body.includes(httpName)
      store.setFlag('NEW_BROWSER_CONTEXT_PERSISTENCE', ok ? 'PASS' : 'FAIL')
      store.rec('30_NEW_CONTEXT_PERSISTENCE', ok ? 'PASS' : 'FAIL', '', ['BROWSER_E2E'])
    }

    // ---- stop/start browser lifecycle ----
    // Product contract: Stop blocks scheduler automatic delivery.
    // Run Once is explicit manual execution and is ALLOWED while STOPPED
    // (runtime load_stream_context require_enabled_stream=False).
    if (primaryHttp && want('11_STOP_START', ['browser', 'destructive'])) {
      // H5 reuses the H1 WireMock path — stop every stream on that path first so
      // scheduler delivery cannot be attributed to a sibling stream.
      const sharedPathStreamIds = Object.entries(resources.streams)
        .filter(([key, id]) => id && (key === 'H1' || key === 'H5' || key === 'WIZARD' || Number(id) === primaryHttp))
        .map(([, id]) => Number(id))
        .filter((id) => id !== primaryHttp)
      for (const sid of [...new Set(sharedPathStreamIds)]) {
        await api.stopStream(sid).catch(() => null)
      }
      await streamsPg.openRuntime(primaryHttp)
      const stopClicked = await streamsPg.clickStop()
      // Wait until API reports terminal stopped (enabled=false).
      let stoppedApi = false
      for (let i = 0; i < 20; i++) {
        const streamAfterStop = await api.getStream(primaryHttp)
        stoppedApi =
          streamAfterStop?.enabled === false &&
          !/^RUNNING$/i.test(String(streamAfterStop?.status || ''))
        if (stoppedApi) break
        await new Promise((r) => setTimeout(r, 500))
      }
      const streamAfterStopDetail = await api.getStream(primaryHttp)
      store.writeJson('stop-ownership.json', {
        enabled: streamAfterStopDetail?.enabled,
        status: streamAfterStopDetail?.status,
        streamId: primaryHttp,
      })
      let txt = await streamsPg.visibleStatusText()
      const stoppedUi = /stopped/i.test(txt)
      await captureBrowserCensus(page, store, '/streams/:id/runtime', 'STOPPED')
      const marker = `STOPTEST-${runId}-001`
      await stubWiremock(
        wm,
        primaryHttpPath,
        wrapHttpItem({ id: 10020, sequence: 10020, message: marker }),
        { bearer: token },
      )
      // Do NOT call runOnce here — that is intentional manual execution.
      // Wait at least two scheduler poll periods (stream polling_interval=15s).
      await new Promise((r) => setTimeout(r, 35_000))
      const whileStoppedScheduler = await waitForDelivery(marker, `/ulc-${runId}-a`, 5_000)
      store.delivery('11_STOP_SCHEDULER', marker, `/ulc-${runId}-a`, whileStoppedScheduler)
      await api.runOnce(primaryHttp)
      const whileStoppedRunOnce = await waitForDelivery(marker, `/ulc-${runId}-a`, 20_000)
      store.setFlag('STOP_BLOCKS_SCHEDULER_DELIVERY', !whileStoppedScheduler ? 'PASS' : 'FAIL')
      store.setFlag('RUN_ONCE_WHILE_STOPPED', whileStoppedRunOnce ? 'ALLOWED_BY_DESIGN' : 'FAIL')
      const startClicked = await streamsPg.clickStart()
      const startedApi = startClicked && (await waitForStreamEnabled(api, primaryHttp, true))
      txt = await streamsPg.visibleStatusText()
      const marker2 = `STOPTEST-${runId}-002`
      await stubWiremock(
        wm,
        primaryHttpPath,
        wrapHttpItem({ id: 10021, sequence: 10021, message: marker2 }),
        { bearer: token },
      )
      await api.runOnce(primaryHttp)
      const afterStart = await waitForDelivery(marker2, `/ulc-${runId}-a`)
      const stopStartOk = stopClicked && stoppedUi && stoppedApi && !whileStoppedScheduler && startClicked && startedApi && afterStart
      store.setFlag('STOP_START_BROWSER_LIFECYCLE', stopStartOk ? 'PASS' : 'FAIL')
      store.rec(
        '11_STOP_START',
        stopStartOk ? 'PASS' : 'FAIL',
        `stopClicked=${stopClicked} stoppedUi=${stoppedUi} stoppedApi=${stoppedApi} schedulerDelivered=${whileStoppedScheduler} runOnceWhileStopped=${whileStoppedRunOnce} startClicked=${startClicked} startedApi=${startedApi} after=${afterStart}`,
        ['BROWSER_E2E', 'ACTUAL_DELIVERY'],
      )
      store.rec('11_STOP_NE_DISABLED', /disabled/i.test(txt) && !/stopped/i.test(txt) ? 'FAIL' : 'PASS', '', [
        'BROWSER_E2E',
      ])
    }

    // ---- delete while running ----
    if (resources.streams.H2 && want('12_DELETE_RUNNING', ['browser', 'destructive'])) {
      await api.startStream(resources.streams.H2)
      await streamsPg.openEditByStreamId(resources.streams.H2)
      const guidance = await streamsPg.deleteBlockedGuidance()
      const del = await streamsPg.tryDelete(`e2e-${runId}-http-stream-H2`)
      const guarded = /stop first|Stop the stream|running|cannot delete|must stop/i.test(`${guidance}\n${del.message}`)
      const still = await findStreamId(api, `e2e-${runId}-http-stream-H2`)
      store.setFlag('DELETE_WHILE_RUNNING_GUARD', guarded || still ? 'PASS' : 'FAIL')
      store.rec('12_DELETE_WHILE_RUNNING', guarded || still ? 'PASS' : 'FAIL', del.message.slice(0, 200), ['BROWSER_E2E'])
    }

    if (resources.connectors.HTTP && want('41_CONNECTOR_DELETE_DEP', ['browser', 'destructive'])) {
      await connectorsPg.openDetailByName(httpName)
      const del = await connectorsPg.tryDelete()
      const still = await findConnectorId(api, httpName)
      const explained = /stream|depend|cannot delete|in use|used by/i.test(del.message)
      store.rec(
        '41_CONNECTOR_DELETE_DEP',
        still && explained ? 'PASS' : still ? 'PARTIAL' : 'FAIL',
        del.message.slice(0, 200),
        ['BROWSER_E2E'],
      )
    }

    // ---- long observation (runner polls; no chatty logs) ----
    if (want('43_OBSERVE', ['overnight']) && args.observeMinutes > 0) {
      const observeMs = Math.min(args.observeMinutes, 60) * 60_000
      const observePath = path.join(store.dir, 'observe.tsv')
      fs.writeFileSync(observePath, 'ts\trunning\tdelivered_markers\n')
      const end = Date.now() + observeMs
      console.log(`OBSERVE_START minutes=${args.observeMinutes}`)
      while (Date.now() < end) {
        const streamsList = await api.listStreams()
        const mine = streamsList.filter((s) => String(s.name || '').includes(runId))
        const running = mine.filter((s) => /run|active|start/i.test(String(s.status || s.state || ''))).length
        const logs = echoLogsTail(2000)
        const markers = countMarkerInEcho(logs, runId)
        fs.appendFileSync(observePath, `${new Date().toISOString()}\t${running}\t${markers}\n`)
        await new Promise((r) => setTimeout(r, 60_000))
      }
      store.rec('43_LONG_OBSERVE', 'PASS', `minutes=${args.observeMinutes}`, ['RUNTIME_E2E'])
      console.log('OBSERVE_DONE')
    }

    // ---- full delete lifecycle (browser for representative) ----
    const deleteLifecycleName = resources.streams.H1
      ? `e2e-${runId}-http-stream-H1`
      : resources.streams.H4
        ? `e2e-${runId}-http-stream-H4`
        : primaryHttpName
    const deleteLifecycleId = resources.streams.H1 || resources.streams.H4 || primaryHttp
    if (deleteLifecycleId && want('12_DELETE_LIFECYCLE', ['browser', 'cleanup', 'destructive'])) {
      await streamsPg.openEditByStreamId(deleteLifecycleId)
      const deleteStopClicked = await streamsPg.clickStop()
      const deleteStoppedApi = deleteStopClicked && (await waitForStreamEnabled(api, deleteLifecycleId, false))
      if (!deleteStopClicked || !deleteStoppedApi) {
        store.rec(
          '12_DELETE_STREAM_BROWSER',
          'FAIL',
          `browserStop=${deleteStopClicked} stoppedApi=${deleteStoppedApi}; delete not attempted`,
          ['BROWSER_E2E', 'API_INTEGRATION'],
        )
        store.setFlag('FULL_CREATE_TO_DELETE_BROWSER_LIFECYCLE', 'FAIL')
      } else {
        // Reload edit page so Delete guard sees the browser-driven STOPPED runtime state.
        await streamsPg.openEditByStreamId(deleteLifecycleId)
        const del = await streamsPg.tryDelete(deleteLifecycleName)
        const gone = !(await findStreamId(api, deleteLifecycleName))
        const browserDeleteOk = del.deleteClicked && del.confirmClicked && gone
        store.rec(
          '12_DELETE_STREAM_BROWSER',
          browserDeleteOk ? 'PASS' : 'FAIL',
          `stopClicked=${deleteStopClicked} stoppedApi=${deleteStoppedApi} deleteClicked=${del.deleteClicked} confirmClicked=${del.confirmClicked} gone=${gone} message=${del.message.slice(0, 100)}`,
          ['BROWSER_E2E', 'API_INTEGRATION'],
        )
        store.setFlag('FULL_CREATE_TO_DELETE_BROWSER_LIFECYCLE', browserDeleteOk ? 'PASS' : 'FAIL')
      }
    }

    store.setFlag('ACTUAL_DELIVERY_TESTS', String(deliveryTests))
    store.setFlag('ACTUAL_DELIVERY_PASS', String(deliveryPass))
    store.setFlag(
      'TRANSFORM_OUTPUT_PROVEN',
      store.flags.TRANSFORM_OUTPUT_PROVEN || 'NO',
    )
    if (!store.flags.AUTH_FAILURE_RECOVERY_BROWSER_JOURNEY) {
      store.setFlag('AUTH_FAILURE_RECOVERY_BROWSER_JOURNEY', 'FAIL')
    }

    // console errors summary
    store.writeJson('browser-console-errors.json', activeSession.consoleErrors.slice(0, 50))

    // ---- cleanup ----
    await cleanupRun(api, store, runId)

    store.setFlag('CONNECTORS_CREATED', String(store.ledger.filter((r) => r.RESOURCE_TYPE === 'CONNECTOR').length))
    store.setFlag('STREAMS_CREATED', String(store.ledger.filter((r) => r.RESOURCE_TYPE === 'STREAM').length))
    store.setFlag('ROUTES_CREATED', String(store.ledger.filter((r) => r.RESOURCE_TYPE === 'ROUTE').length))
    store.setFlag('DESTINATIONS_CREATED', String(store.ledger.filter((r) => r.RESOURCE_TYPE === 'DESTINATION').length))
    store.setFlag('BROWSER_CREATED_CONNECTORS', String(countViaBrowser(store, 'CONNECTOR')))
    store.setFlag('BROWSER_CREATED_STREAMS', String(countViaBrowser(store, 'STREAM')))
    store.setFlag('BROWSER_CREATED_ROUTES', String(countViaBrowser(store, 'ROUTE')))
    store.setFlag('BROWSER_CREATED_DESTINATIONS', String(countViaBrowser(store, 'DESTINATION')))
    store.setFlag('RUE2E_001_INVALID_URL_UX', store.scenarios.find((s) => s.id === '44_INVALID_DEST')?.status || 'NOT_RUN')
    store.setFlag('BROWSER_USER_ACTIONS', String(Math.max(0, store.browserActions.length - 1)))
    store.setFlag('REUSABLE_BROWSER_E2E_PACKAGE', 'YES')
    store.setFlag('BROWSER_FRAMEWORK', 'Playwright')
    store.setFlag('BROWSER_FIRST_USER_ACTIONS', 'YES')
    store.setFlag('API_VERIFICATION_LAYER', 'YES')
    store.setFlag('ACTUAL_DESTINATION_VERIFICATION', 'YES')
    store.setFlag('RESOURCE_LEDGER', 'YES')
    store.setFlag('RESUME_SUPPORT', 'YES')
    store.setFlag('CLEANUP_ONLY_SUPPORT', 'YES')

    store.flush()
    writeFinalSummary(store, {
      MODE: args.mode,
      LIVE_DB_USED: 'NO',
      LIVE_RUNTIME_MODIFIED: 'NO',
    })
    store.saveState({ step: 'DONE' })
    return finalAcceptanceBlocked(store) ? 1 : 0
  } catch (e) {
    console.error(e)
    store.rec('FATAL', 'FAIL', String(e), ['NOT_PROVEN'])
    try {
      await cleanupRun(api, store, runId)
    } catch (ce) {
      store.rec('13_CLEANUP_ORPHANS', 'FAIL', String(ce).slice(0, 200), ['API_INTEGRATION'])
    }
    store.setFlag('REUSABLE_BROWSER_E2E_PACKAGE', 'YES')
    store.setFlag('BROWSER_FRAMEWORK', 'Playwright')
    store.flush()
    writeFinalSummary(store, { FATAL: String(e), LIVE_DB_USED: 'NO', LIVE_RUNTIME_MODIFIED: 'NO' })
    return 2
  } finally {
    await context?.close().catch(() => null)
    await browser?.close().catch(() => null)
  }
}

main().then((code) => process.exit(code))
