/**
 * ID-based cleanup for Full E2E Lab created resources.
 *
 * Order (from product API/FK constraints in app/streams/delete_scope.py + routers):
 * 1. Stop streams (RUNNING blocks DELETE)
 * 2. DELETE streams (removes routes, mappings, enrichments, checkpoints, delivery_logs)
 * 3. Disable remaining routes then DELETE (orphan safety)
 * 4. Disable destinations then DELETE
 * 5. DELETE connectors (cascades sources)
 * 6. Optional collector reset
 *
 * Never deletes by name prefix alone. Never touches [DEV VALIDATION] or non-owned IDs.
 * Cleanup success must not overwrite scenario FAIL — callers keep the test exit code.
 */
import type { APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  createdResourcesPath,
  loadCreatedResources,
  listOwnedRunIds,
  reportDir,
  saveCreatedResources,
  type CreatedResourceRecord,
  type CreatedResourcesFile,
  type ResourceKind,
} from './resource-registry'
import { loadLabEnv } from './fixture-client'

export type CleanupAction = {
  kind: ResourceKind
  id: number | string
  action: string
  ok: boolean
  status?: number
  detail?: string
  alreadyGone?: boolean
}

export type CleanupReport = {
  runId: string
  startedAt: string
  finishedAt: string
  actions: CleanupAction[]
  remaining: {
    connectors: number[]
    streams: number[]
    routes: number[]
    destinations: number[]
    checkpoints: number[]
  }
  ok: boolean
  errors: string[]
}

export type CleanupClient = {
  apiBaseUrl: string
  request: APIRequestContext
  accessToken?: string | null
  webhookCollectorUrl?: string
  syslogCollectorApiUrl?: string
}

function authHeaders(token?: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

function url(base: string, p: string): string {
  return `${base.replace(/\/$/, '')}${p.startsWith('/') ? p : `/${p}`}`
}

/** Per cleanup API call budget. Unbounded waits previously hung Playwright until test timeout. */
export const CLEANUP_API_TIMEOUT_MS = 30_000

async function api(
  client: CleanupClient,
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  p: string,
  data?: unknown,
): Promise<{ status: number; ok: boolean; body: unknown; timedOut?: boolean }> {
  const headers = authHeaders(client.accessToken)
  const full = url(client.apiBaseUrl, p)
  const timeout = CLEANUP_API_TIMEOUT_MS
  try {
    let res
    if (method === 'GET') res = await client.request.get(full, { headers, timeout })
    else if (method === 'DELETE') res = await client.request.delete(full, { headers, timeout })
    else if (method === 'POST') res = await client.request.post(full, { headers, data, timeout })
    else res = await client.request.put(full, { headers, data, timeout })
    let body: unknown = null
    try {
      const text = await res.text()
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: res.status(), ok: res.ok(), body }
  } catch (err) {
    const msg = String(err)
    if (/Timeout|timed out|timeout/i.test(msg)) {
      return { status: 0, ok: false, body: { error: msg }, timedOut: true }
    }
    throw err
  }
}

function numericIds(resources: CreatedResourceRecord[], kind: ResourceKind): number[] {
  const out: number[] = []
  for (const r of resources) {
    if (r.kind !== kind || r.ownership !== 'full-e2e-lab') continue
    const n = Number(r.id)
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return [...new Set(out)]
}

function apiFailureDetail(res: { ok: boolean; body: unknown; timedOut?: boolean }): string | undefined {
  if (res.ok) return undefined
  if (res.timedOut) return `timeout after ${CLEANUP_API_TIMEOUT_MS}ms`
  return JSON.stringify(res.body)
}

async function stopStream(client: CleanupClient, streamId: number): Promise<CleanupAction> {
  const res = await api(client, 'PUT', `/api/v1/streams/${streamId}`, { enabled: false, status: 'STOPPED' })
  if (res.status === 404) {
    return { kind: 'stream', id: streamId, action: 'stop', ok: true, status: 404, alreadyGone: true }
  }
  return {
    kind: 'stream',
    id: streamId,
    action: 'stop',
    ok: res.ok || res.status === 404,
    status: res.status,
    detail: apiFailureDetail(res),
  }
}

async function deleteStream(client: CleanupClient, streamId: number): Promise<CleanupAction> {
  await stopStream(client, streamId)
  const res = await api(client, 'DELETE', `/api/v1/streams/${streamId}`)
  if (res.status === 404) {
    return { kind: 'stream', id: streamId, action: 'delete', ok: true, status: 404, alreadyGone: true }
  }
  return {
    kind: 'stream',
    id: streamId,
    action: 'delete',
    ok: res.ok,
    status: res.status,
    detail: apiFailureDetail(res),
  }
}

async function deleteRoute(client: CleanupClient, routeId: number): Promise<CleanupAction> {
  const disable = await api(client, 'PUT', `/api/v1/routes/${routeId}`, { enabled: false, status: 'DISABLED' })
  if (disable.status === 404) {
    return { kind: 'route', id: routeId, action: 'delete', ok: true, status: 404, alreadyGone: true }
  }
  const res = await api(client, 'DELETE', `/api/v1/routes/${routeId}`)
  if (res.status === 404) {
    return { kind: 'route', id: routeId, action: 'delete', ok: true, status: 404, alreadyGone: true }
  }
  return {
    kind: 'route',
    id: routeId,
    action: 'delete',
    ok: res.ok,
    status: res.status,
    detail: apiFailureDetail(res),
  }
}

async function deleteDestination(client: CleanupClient, destinationId: number): Promise<CleanupAction> {
  const disable = await api(client, 'PUT', `/api/v1/destinations/${destinationId}`, { enabled: false })
  if (disable.status === 404) {
    return { kind: 'destination', id: destinationId, action: 'delete', ok: true, status: 404, alreadyGone: true }
  }
  const res = await api(client, 'DELETE', `/api/v1/destinations/${destinationId}`)
  if (res.status === 404) {
    return { kind: 'destination', id: destinationId, action: 'delete', ok: true, status: 404, alreadyGone: true }
  }
  return {
    kind: 'destination',
    id: destinationId,
    action: 'delete',
    ok: res.ok,
    status: res.status,
    detail: apiFailureDetail(res),
  }
}

async function deleteConnector(client: CleanupClient, connectorId: number): Promise<CleanupAction> {
  const res = await api(client, 'DELETE', `/api/v1/connectors/${connectorId}`)
  if (res.status === 404) {
    return { kind: 'connector', id: connectorId, action: 'delete', ok: true, status: 404, alreadyGone: true }
  }
  return {
    kind: 'connector',
    id: connectorId,
    action: 'delete',
    ok: res.ok,
    status: res.status,
    detail: apiFailureDetail(res),
  }
}

async function existsGet(client: CleanupClient, p: string): Promise<boolean> {
  const res = await api(client, 'GET', p)
  return res.ok
}

async function resetCollectors(client: CleanupClient): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = []
  for (const [kind, base] of [
    ['correlation', client.webhookCollectorUrl],
    ['correlation', client.syslogCollectorApiUrl],
  ] as const) {
    if (!base) continue
    try {
      const res = await client.request.post(`${base.replace(/\/$/, '')}/reset`)
      actions.push({
        kind,
        id: base,
        action: 'collector_reset',
        ok: res.ok(),
        status: res.status(),
      })
    } catch (err) {
      actions.push({ kind, id: base, action: 'collector_reset', ok: false, detail: String(err) })
    }
  }
  return actions
}

/**
 * Cleanup resources recorded in created-resources.json for a run.
 * Idempotent: missing resources count as success.
 */
export async function cleanupRegisteredResources(
  client: CleanupClient,
  runId: string,
  opts?: { resetCollectors?: boolean; registry?: CreatedResourcesFile },
): Promise<CleanupReport> {
  const startedAt = new Date().toISOString()
  const file = opts?.registry ?? loadCreatedResources(runId)
  const actions: CleanupAction[] = []
  const errors: string[] = []

  if (!file || file.ownership !== 'full-e2e-lab') {
    const finishedAt = new Date().toISOString()
    const ownershipMsg = file
      ? file.ownership === 'continuous-e2e-lab'
        ? 'created-resources.json ownership is continuous-e2e-lab; ephemeral cleanup refuses continuous resources (use continuous:teardown)'
        : `created-resources.json ownership is ${file.ownership}, refuse cleanup`
      : `missing created-resources.json for run ${runId}`
    const report: CleanupReport = {
      runId,
      startedAt,
      finishedAt,
      actions: [],
      remaining: { connectors: [], streams: [], routes: [], destinations: [], checkpoints: [] },
      ok: false,
      errors: [ownershipMsg],
    }
    writeCleanupReport(runId, report)
    return report
  }

  const owned = file.resources.filter((r) => r.ownership === 'full-e2e-lab')
  const streamIds = numericIds(owned, 'stream')
  const routeIds = numericIds(owned, 'route')
  const destinationIds = numericIds(owned, 'destination')
  const connectorIds = numericIds(owned, 'connector')

  for (const id of streamIds) {
    const a = await deleteStream(client, id)
    actions.push(a)
    if (!a.ok) errors.push(`stream ${id}: ${a.detail || a.status}`)
  }

  for (const id of routeIds) {
    const a = await deleteRoute(client, id)
    actions.push(a)
    // Routes often already removed with stream delete — 404 is ok; other errors soft-warn.
    if (!a.ok && !a.alreadyGone) {
      // soft: do not fail hard if stream cascade already removed route
      if (a.status !== 409) errors.push(`route ${id}: ${a.detail || a.status}`)
    }
  }

  for (const id of destinationIds) {
    const a = await deleteDestination(client, id)
    actions.push(a)
    if (!a.ok) errors.push(`destination ${id}: ${a.detail || a.status}`)
  }

  for (const id of connectorIds) {
    const a = await deleteConnector(client, id)
    actions.push(a)
    if (!a.ok) errors.push(`connector ${id}: ${a.detail || a.status}`)
  }

  if (opts?.resetCollectors !== false) {
    actions.push(...(await resetCollectors(client)))
  }

  const remaining = await probeRemaining(client, {
    connectors: connectorIds,
    streams: streamIds,
    routes: routeIds,
    destinations: destinationIds,
    checkpoints: streamIds,
  })

  const ok =
    remaining.connectors.length === 0 &&
    remaining.streams.length === 0 &&
    remaining.routes.length === 0 &&
    remaining.destinations.length === 0 &&
    remaining.checkpoints.length === 0

  if (!ok) {
    errors.push(
      `remaining after cleanup: connectors=${remaining.connectors} streams=${remaining.streams} routes=${remaining.routes} destinations=${remaining.destinations} checkpoints=${remaining.checkpoints}`,
    )
  }

  const report: CleanupReport = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    actions,
    remaining,
    ok,
    errors,
  }
  writeCleanupReport(runId, report)
  return report
}

export async function validateCleanup(
  client: CleanupClient,
  runId: string,
): Promise<CleanupReport> {
  const file = loadCreatedResources(runId)
  const startedAt = new Date().toISOString()
  if (!file || file.ownership !== 'full-e2e-lab') {
    const report: CleanupReport = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      actions: [],
      remaining: { connectors: [], streams: [], routes: [], destinations: [], checkpoints: [] },
      ok: false,
      errors: [file ? 'invalid ownership' : `missing registry for ${runId}`],
    }
    writeCleanupReport(runId, report, 'cleanup-validation.json')
    return report
  }
  const owned = file.resources.filter((r) => r.ownership === 'full-e2e-lab')
  const remaining = await probeRemaining(client, {
    connectors: numericIds(owned, 'connector'),
    streams: numericIds(owned, 'stream'),
    routes: numericIds(owned, 'route'),
    destinations: numericIds(owned, 'destination'),
    checkpoints: numericIds(owned, 'checkpoint').length
      ? numericIds(owned, 'checkpoint')
      : numericIds(owned, 'stream'),
  })
  const ok =
    remaining.connectors.length === 0 &&
    remaining.streams.length === 0 &&
    remaining.routes.length === 0 &&
    remaining.destinations.length === 0 &&
    remaining.checkpoints.length === 0
  const report: CleanupReport = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    actions: [],
    remaining,
    ok,
    errors: ok ? [] : [`resources still present: ${JSON.stringify(remaining)}`],
  }
  writeCleanupReport(runId, report, 'cleanup-validation.json')
  return report
}

async function probeRemaining(
  client: CleanupClient,
  ids: {
    connectors: number[]
    streams: number[]
    routes: number[]
    destinations: number[]
    checkpoints: number[]
  },
): Promise<CleanupReport['remaining']> {
  const remaining: CleanupReport['remaining'] = {
    connectors: [],
    streams: [],
    routes: [],
    destinations: [],
    checkpoints: [],
  }
  for (const id of ids.streams) {
    if (await existsGet(client, `/api/v1/streams/${id}`)) remaining.streams.push(id)
  }
  for (const id of ids.routes) {
    if (await existsGet(client, `/api/v1/routes/${id}`)) remaining.routes.push(id)
  }
  for (const id of ids.destinations) {
    if (await existsGet(client, `/api/v1/destinations/${id}`)) remaining.destinations.push(id)
  }
  for (const id of ids.connectors) {
    if (await existsGet(client, `/api/v1/connectors/${id}`)) remaining.connectors.push(id)
  }
  for (const id of ids.checkpoints) {
    // Checkpoint is stream-scoped; if stream is gone, checkpoint is gone.
    if (remaining.streams.includes(id)) {
      remaining.checkpoints.push(id)
      continue
    }
    const res = await api(client, 'GET', `/api/v1/runtime/streams/${id}/checkpoint`)
    if (res.ok && res.body && typeof res.body === 'object') {
      const body = res.body as { stream_id?: number; exists?: boolean; checkpoint?: unknown }
      // Some APIs return empty object when missing; treat explicit stream_id match as present only if payload non-empty.
      if (body.checkpoint != null || body.exists === true) remaining.checkpoints.push(id)
    }
  }
  return remaining
}

function writeCleanupReport(runId: string, report: CleanupReport, name = 'cleanup-report.json'): void {
  const dir = reportDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), JSON.stringify(report, null, 2) + '\n', 'utf8')
}

/**
 * Cleanup all runs that have ownership evidence in created-resources.json.
 * Does NOT invent IDs from name prefix alone.
 */
export async function cleanupStaleOwnedRuns(
  client: CleanupClient,
  opts?: { runIds?: string[]; resetCollectors?: boolean },
): Promise<{ runId: string; report: CleanupReport }[]> {
  const runIds = opts?.runIds ?? listOwnedRunIds()
  const out: { runId: string; report: CleanupReport }[] = []
  for (const runId of runIds) {
    const report = await cleanupRegisteredResources(client, runId, {
      resetCollectors: opts?.resetCollectors ?? false,
    })
    out.push({ runId, report })
  }
  if (opts?.resetCollectors !== false && runIds.length) {
    await resetCollectors(client)
  }
  return out
}

/** Cleanup using an in-memory / just-written registry (e.g. scenario finally). */
export async function cleanupResourcesFromRecords(
  client: CleanupClient,
  runId: string,
  resources: CreatedResourceRecord[],
  opts?: { resetCollectors?: boolean },
): Promise<CleanupReport> {
  const registry: CreatedResourcesFile = {
    runId,
    ownership: 'full-e2e-lab',
    updatedAt: new Date().toISOString(),
    resources: resources.filter((r) => r.ownership === 'full-e2e-lab'),
  }
  saveCreatedResources(
    (() => {
      const existing = loadCreatedResources(runId)
      if (!existing) return registry
      const merged = {
        ...existing,
        resources: [...existing.resources, ...registry.resources],
      }
      // de-dupe via save path — ResourceRegistry merge would be nicer; keep simple unique by kind+id
      const seen = new Set<string>()
      merged.resources = merged.resources.filter((r) => {
        const k = `${r.kind}:${r.id}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      return merged
    })(),
  )
  return cleanupRegisteredResources(client, runId, { ...opts, registry: loadCreatedResources(runId) ?? registry })
}

export function ensureRegistryPath(runId: string): string {
  return createdResourcesPath(runId)
}

/** Build CleanupClient from Playwright request + lab env. */
export function cleanupClientFromEnv(
  request: APIRequestContext,
  accessToken?: string | null,
): CleanupClient {
  const env = loadLabEnv()
  return {
    apiBaseUrl: env.apiBaseUrl,
    request,
    accessToken,
    webhookCollectorUrl: env.webhookCollectorUrl,
    syslogCollectorApiUrl: env.syslogCollectorApiUrl,
  }
}
