import type { RouteRead } from '../../api/gdcRoutes'
import type { DestinationRead, DestinationListItem } from '../../api/gdcDestinations'
import type {
  OperationalHealthStatus,
  OperationalRouteSnapshot,
  OperationalSnapshotResponse,
} from '../../api/operationalSnapshot'
import type { DestinationDeliveryOutcomesResponse, RouteRuntimeMetricsRow, StreamRead } from '../../api/types/gdcApi'
import type { StreamRuntimeMetricsResponse } from '../../api/types/gdcApi'
import { formatPlatformRelative } from '../../lib/platform-timestamps'
import {
  formatOperationalEps,
  formatOperationalHealth,
  formatOperationalSuccessRate,
  formatProblemSummary,
  resolveLastActivityAt,
} from '../../lib/operational-snapshot-selectors'
import { resolveRouteRuntimeRows } from '../streams/route-operational-panel'

export type RouteUiStatus = 'Healthy' | 'Warning' | 'Error' | 'Disabled' | 'Idle'

export type RouteConsoleRow = {
  route: RouteRead
  stream: StreamRead | null
  destination: DestinationListItem | DestinationRead | null
  metrics: RouteRuntimeMetricsRow | null
  uiStatus: RouteUiStatus
  routeLabel: string
}

function uiStatusFromHealthLabel(label: ReturnType<typeof formatOperationalHealth>['label']): RouteUiStatus {
  if (label === 'Healthy') return 'Healthy'
  if (label === 'Warning') return 'Warning'
  if (label === 'Error') return 'Error'
  if (label === 'Disabled') return 'Disabled'
  return 'Idle'
}

export function routePublicId(routeId: number): string {
  return `R-${String(routeId).padStart(4, '0')}`
}

export function uiStatusFromOperationalHealth(
  health: OperationalHealthStatus,
  enabled: boolean,
): RouteUiStatus {
  return uiStatusFromHealthLabel(formatOperationalHealth(health, enabled).label)
}

export function getRouteHealthPresentation(health: OperationalHealthStatus): {
  uiStatus: RouteUiStatus
  label: RouteUiStatus
} {
  const uiStatus = uiStatusFromOperationalHealth(health, true)
  return { uiStatus, label: uiStatus }
}

export function formatEps(value: number | null | undefined): string {
  return formatOperationalEps(value)
}

export function formatSuccessRate(value: number | null | undefined): string {
  return formatOperationalSuccessRate(value)
}

export function getLastActivityAt(route: OperationalRouteSnapshot): string | null {
  return resolveLastActivityAt(route.last_success_at, route.last_error_at)
}

export function getRouteProblemSummary(route: OperationalRouteSnapshot): string | null {
  return formatProblemSummary(route.last_error_message, route.health_status, 'Route delivery degraded', 'Route delivery error')
}

function connectivityFromOperationalHealth(health: OperationalHealthStatus): RouteRuntimeMetricsRow['connectivity_state'] {
  if (health === 'ERROR') return 'ERROR'
  if (health === 'DEGRADED') return 'DEGRADED'
  if (health === 'IDLE') return 'IDLE'
  return 'HEALTHY'
}

/** Map operational snapshot route row to legacy metrics shape for table/detail reuse. */
export function metricsFromOperationalRoute(
  route: OperationalRouteSnapshot,
  _problems: OperationalSnapshotResponse['problems'] = [],
): RouteRuntimeMetricsRow {
  const destId = route.destination_id ?? 0
  const failedApprox1m = Math.round(route.failed_eps_1m * 60)
  const deliveredApprox1m = Math.round(route.delivered_eps_1m * 60)
  return {
    route_id: route.route_id,
    destination_id: destId,
    destination_name: (route.destination_name ?? '').trim() || `Destination #${destId}`,
    destination_type: (route.destination_type ?? '').trim() || '—',
    enabled: route.enabled,
    route_status: route.enabled ? 'ENABLED' : 'DISABLED',
    success_rate: route.success_rate_5m,
    events_last_hour: deliveredApprox1m + failedApprox1m,
    delivered_last_hour: deliveredApprox1m,
    failed_last_hour: failedApprox1m,
    avg_latency_ms: route.avg_latency_ms ?? 0,
    p95_latency_ms: route.avg_latency_ms ?? 0,
    max_latency_ms: route.avg_latency_ms ?? 0,
    eps_current: route.delivered_eps_1m,
    retry_count_last_hour: Math.round((route.retry_rate_5m / 100) * Math.max(1, deliveredApprox1m + failedApprox1m)),
    last_success_at: route.last_success_at,
    last_failure_at: route.last_error_at,
    last_error_message: route.last_error_message,
    last_error_code: null,
    failure_policy: route.failure_policy ?? '',
    connectivity_state: connectivityFromOperationalHealth(route.health_status),
    disable_reason: null,
    latency_trend: [],
    success_rate_trend: [],
  }
}

function streamFromSnapshotRoute(
  route: OperationalRouteSnapshot,
  streamMeta?: StreamRead | null,
): StreamRead | null {
  if (typeof route.stream_id !== 'number') return null
  if (streamMeta != null) return streamMeta
  return {
    id: route.stream_id,
    name: (route.stream_name ?? '').trim() || `Stream #${route.stream_id}`,
    connector_id: null,
    source_id: null,
    status: null,
  }
}

function destinationFromSnapshotRoute(
  route: OperationalRouteSnapshot,
  destinationMeta?: DestinationListItem | DestinationRead | null,
): DestinationListItem | DestinationRead | null {
  const did = route.destination_id
  if (typeof did !== 'number') return null
  if (destinationMeta != null) return destinationMeta
  const dtype = (route.destination_type ?? '').trim()
  if (!dtype) {
    return {
      id: did,
      name: (route.destination_name ?? '').trim() || `Destination #${did}`,
      destination_type: 'SYSLOG_UDP',
      config_json: {},
      rate_limit_json: {},
      enabled: true,
      created_at: null,
      updated_at: null,
    }
  }
  return {
    id: did,
    name: (route.destination_name ?? '').trim() || `Destination #${did}`,
    destination_type: dtype as DestinationListItem['destination_type'],
    config_json: {},
    rate_limit_json: {},
    enabled: true,
    created_at: null,
    updated_at: null,
    streams_using_count: 0,
    routes: [],
  }
}

function mergeRouteMetadata(routeMeta: RouteRead | undefined, snap: OperationalRouteSnapshot): RouteRead {
  if (routeMeta != null) {
    return {
      ...routeMeta,
      enabled: snap.enabled,
      failure_policy: snap.failure_policy ?? routeMeta.failure_policy,
      stream_id: snap.stream_id,
      destination_id: snap.destination_id ?? routeMeta.destination_id,
    }
  }
  return {
    id: snap.route_id,
    stream_id: snap.stream_id,
    destination_id: snap.destination_id,
    enabled: snap.enabled,
    failure_policy: snap.failure_policy,
    formatter_config_json: {},
    rate_limit_json: {},
    status: snap.enabled ? 'ENABLED' : 'DISABLED',
  }
}

export type RouteSnapshotEntityLookup = {
  streams?: readonly StreamRead[]
  destinations?: readonly DestinationListItem[]
}

export function buildRouteRowsFromOperationalSnapshot(
  snapshot: OperationalSnapshotResponse,
  routesMetadata: RouteRead[] = [],
  entityLookup?: RouteSnapshotEntityLookup,
): RouteConsoleRow[] {
  const metaById = new Map(routesMetadata.map((r) => [r.id, r]))
  const streamById = new Map((entityLookup?.streams ?? []).map((s) => [s.id, s]))
  const destById = new Map((entityLookup?.destinations ?? []).map((d) => [d.id, d]))
  const problems = snapshot.problems ?? []
  return (snapshot.routes ?? []).map((snap) => {
    const route = mergeRouteMetadata(metaById.get(snap.route_id), snap)
    const stream = streamFromSnapshotRoute(snap, streamById.get(snap.stream_id))
    const destination =
      snap.destination_id != null
        ? destinationFromSnapshotRoute(snap, destById.get(snap.destination_id))
        : null
    const destEnabled = destination?.enabled !== false
    const uiStatus =
      snap.enabled === false || !destEnabled
        ? 'Disabled'
        : uiStatusFromOperationalHealth(snap.health_status, true)
    const routeLabel = (route.name ?? '').trim() || routePublicId(route.id)
    return {
      route,
      stream,
      destination,
      metrics: metricsFromOperationalRoute(snap, problems),
      uiStatus,
      routeLabel,
    }
  })
}

export function metricsMapFromOperationalSnapshot(
  snapshot: OperationalSnapshotResponse,
): Map<number, RouteRuntimeMetricsRow> {
  const map = new Map<number, RouteRuntimeMetricsRow>()
  const problems = snapshot.problems ?? []
  for (const row of snapshot.routes ?? []) {
    map.set(row.route_id, metricsFromOperationalRoute(row, problems))
  }
  return map
}

export function formatFailurePolicy(policy: string | null | undefined): string {
  const p = (policy ?? '').trim()
  switch (p) {
    case 'LOG_AND_CONTINUE':
      return 'Log and Continue'
    case 'PAUSE_STREAM_ON_FAILURE':
      return 'Pause Stream on Failure'
    case 'DISABLE_ROUTE_ON_FAILURE':
      return 'Disable Route on Failure'
    case 'RETRY_AND_BACKOFF':
      return 'Retry (Exponential)'
    default:
      return p || '—'
  }
}

export function formatRateLimitCell(rateLimitJson: Record<string, unknown> | null | undefined): string {
  if (!rateLimitJson || typeof rateLimitJson !== 'object') return '—'
  const enabled = rateLimitJson.enabled
  if (enabled === false) return 'Off'
  const ps = rateLimitJson.per_second
  const burst = rateLimitJson.burst_size
  if (typeof ps === 'number' && typeof burst === 'number') return `${ps}/s · burst ${burst}`
  if (typeof ps === 'number') return `${ps}/s`
  return 'On'
}

export function formatDestinationEndpoint(
  dest: DestinationListItem | DestinationRead | null,
): { hostOrUrl: string; port: string | null; protocol: string | null } {
  if (!dest) return { hostOrUrl: '—', port: null, protocol: null }
  const cfg = dest.config_json ?? {}
  if (dest.destination_type === 'WEBHOOK_POST') {
    return {
      hostOrUrl: typeof cfg.url === 'string' && cfg.url.trim() ? cfg.url.trim() : '—',
      port: null,
      protocol: 'HTTPS',
    }
  }
  const host = typeof cfg.host === 'string' ? cfg.host : '—'
  const port = cfg.port != null ? String(cfg.port) : '514'
  const proto = dest.destination_type === 'SYSLOG_TCP' ? 'TCP' : 'UDP'
  return { hostOrUrl: host, port, protocol: proto }
}

export function backoffFieldsFromRoute(rateLimitJson: Record<string, unknown> | null | undefined): {
  maxRetries: string
  initialBackoffSec: string
  maxBackoffSec: string
} {
  if (!rateLimitJson || typeof rateLimitJson !== 'object') {
    return { maxRetries: '—', initialBackoffSec: '—', maxBackoffSec: '—' }
  }
  const maxR = rateLimitJson.max_retry
  const initB = rateLimitJson.initial_backoff_sec
  const maxB = rateLimitJson.max_backoff_sec
  return {
    maxRetries: typeof maxR === 'number' ? String(maxR) : '—',
    initialBackoffSec: typeof initB === 'number' ? String(initB) : '—',
    maxBackoffSec: typeof maxB === 'number' ? String(maxB) : '—',
  }
}

export function deriveRouteUiStatus(
  route: RouteRead,
  destEnabled: boolean,
  m: RouteRuntimeMetricsRow | null,
): RouteUiStatus {
  if (route.enabled === false || !destEnabled) return 'Disabled'
  if (!m) return 'Idle'

  const delivered = m.delivered_last_hour
  const failed = m.failed_last_hour
  const events = delivered + failed
  const sr = m.success_rate
  const lat = m.avg_latency_ms

  if (events <= 0) return 'Idle'

  if (m.connectivity_state === 'DISABLED') return 'Disabled'
  if (m.connectivity_state === 'ERROR') return 'Error'

  if (failed > 0 && delivered === 0) return 'Error'
  if (sr < 90) return 'Error'

  if (
    m.connectivity_state === 'DEGRADED' ||
    sr < 98 ||
    lat > 250 ||
    (failed > 0 && delivered > 0)
  ) {
    return 'Warning'
  }

  return 'Healthy'
}

export function buildRouteConsoleRows(
  routes: RouteRead[],
  streams: StreamRead[],
  destinations: DestinationListItem[],
  metricsByRouteId: Map<number, RouteRuntimeMetricsRow>,
): RouteConsoleRow[] {
  const streamById = new Map(streams.map((s) => [s.id, s]))
  const destById = new Map(destinations.map((d) => [d.id, d]))

  return routes.map((route) => {
    const sid = route.stream_id
    const did = route.destination_id
    const stream = typeof sid === 'number' ? streamById.get(sid) ?? null : null
    const destination = typeof did === 'number' ? destById.get(did) ?? null : null
    const m = typeof route.id === 'number' ? metricsByRouteId.get(route.id) ?? null : null
    const destEnabled = destination?.enabled !== false
    const uiStatus =
      route.enabled === false || !destEnabled
        ? 'Disabled'
        : deriveRouteUiStatus(route, destEnabled, m)
    const routeLabel = (route.name ?? '').trim() || routePublicId(route.id)
    return {
      route,
      stream,
      destination,
      metrics: m,
      uiStatus,
      routeLabel,
    }
  })
}

export function mergeMetricsFromStreams(metricsList: (StreamRuntimeMetricsResponse | null)[]): Map<number, RouteRuntimeMetricsRow> {
  const map = new Map<number, RouteRuntimeMetricsRow>()
  for (const m of metricsList) {
    if (!m) continue
    for (const row of resolveRouteRuntimeRows(m)) {
      map.set(row.route_id, row)
    }
  }
  return map
}

export function mergeThroughputSeries(metricsList: (StreamRuntimeMetricsResponse | null)[]): { timestamp: string; eps: number }[] {
  const acc = new Map<string, number>()
  for (const m of metricsList) {
    if (!m?.throughput_over_time?.length) continue
    for (const pt of m.throughput_over_time) {
      acc.set(pt.timestamp, (acc.get(pt.timestamp) ?? 0) + pt.events_per_sec)
    }
  }
  return [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([timestamp, eps]) => ({ timestamp, eps }))
}

export function mergeSuccessRateFromBuckets(metricsList: (StreamRuntimeMetricsResponse | null)[]): { timestamp: string; pct: number }[] {
  const delMap = new Map<string, number>()
  const failMap = new Map<string, number>()
  for (const m of metricsList) {
    if (!m?.events_over_time?.length) continue
    for (const b of m.events_over_time) {
      delMap.set(b.timestamp, (delMap.get(b.timestamp) ?? 0) + b.delivered)
      failMap.set(b.timestamp, (failMap.get(b.timestamp) ?? 0) + b.failed)
    }
  }
  const keys = new Set([...delMap.keys(), ...failMap.keys()])
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((timestamp) => {
      const d = delMap.get(timestamp) ?? 0
      const f = failMap.get(timestamp) ?? 0
      const tot = d + f
      const pct = tot <= 0 ? 0 : Math.round((1000 * d) / tot) / 10
      return { timestamp, pct }
    })
}

export function aggregateDestinationDonut(metricsByRouteId: Map<number, RouteRuntimeMetricsRow>): { name: string; value: number }[] {
  const byDest = new Map<string, number>()
  for (const row of metricsByRouteId.values()) {
    const name = (row.destination_name ?? '').trim() || `Destination #${row.destination_id}`
    const v = row.delivered_last_hour + row.failed_last_hour
    if (v <= 0) continue
    byDest.set(name, (byDest.get(name) ?? 0) + v)
  }
  return [...byDest.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
}

export function destinationOutcomeDonutFromApi(
  outcomes: DestinationDeliveryOutcomesResponse | null,
  destinations: DestinationListItem[],
): { name: string; value: number }[] {
  const destById = new Map(destinations.map((d) => [d.id, d]))
  return (outcomes?.rows ?? [])
    .map((row) => {
      const dest = destById.get(row.destination_id)
      const name = (dest?.name ?? '').trim() || `Destination #${row.destination_id}`
      return { name, value: row.success_events + row.failure_events }
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
}

export function countRouteStatuses(rows: RouteConsoleRow[]): {
  healthy: number
  warning: number
  error: number
  disabled: number
  idle: number
  total: number
} {
  let healthy = 0
  let warning = 0
  let error = 0
  let disabled = 0
  let idle = 0
  for (const r of rows) {
    switch (r.uiStatus) {
      case 'Healthy':
        healthy++
        break
      case 'Warning':
        warning++
        break
      case 'Error':
        error++
        break
      case 'Disabled':
        disabled++
        break
      case 'Idle':
        idle++
        break
      default:
        break
    }
  }
  return { healthy, warning, error, disabled, idle, total: rows.length }
}

/** Latest activity timestamp for delivery (success vs failure, whichever is newer). */
export function lastActivityIso(m: RouteRuntimeMetricsRow | null): string | null {
  if (!m) return null
  const a = m.last_success_at
  const b = m.last_failure_at
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

export function relativeShort(iso: string | null | undefined): string {
  return formatPlatformRelative(iso)
}

export type RouteQuickFilter = 'all' | 'healthy' | 'warning' | 'error' | 'disabled' | 'problem'

export type RouteConsoleFilters = {
  searchQuery: string
  streamFilter: string
  destinationFilter: string
  statusFilter: string
  policyFilter: string
  quickFilter: RouteQuickFilter
  highErr: boolean
  highLat: boolean
}

/** Stable memoized route filtering (search should be debounced before calling). */
export function filterRouteConsoleRows(rows: readonly RouteConsoleRow[], filters: RouteConsoleFilters): RouteConsoleRow[] {
  const q = filters.searchQuery.trim().toLowerCase()
  return rows.filter((row) => {
    const destName = (row.destination?.name ?? '').trim()
    const streamName = (row.stream?.name ?? '').trim()
    const streamId = row.stream?.id ?? row.route.stream_id
    const hay = `${row.routeLabel} ${routePublicId(row.route.id)} ${streamName} ${destName}`.toLowerCase()
    if (q && !hay.includes(q)) return false
    if (filters.streamFilter !== '__all__' && String(streamId) !== filters.streamFilter) return false
    if (filters.destinationFilter !== '__all__' && destName !== filters.destinationFilter) return false
    if (filters.policyFilter !== '__all__' && (row.route.failure_policy ?? '') !== filters.policyFilter) return false
    if (filters.statusFilter !== '__all__') {
      const want = filters.statusFilter as RouteUiStatus
      if (row.uiStatus !== want) return false
    }
    if (filters.quickFilter === 'healthy' && row.uiStatus !== 'Healthy') return false
    if (filters.quickFilter === 'warning' && row.uiStatus !== 'Warning') return false
    if (filters.quickFilter === 'error' && row.uiStatus !== 'Error') return false
    if (filters.quickFilter === 'disabled' && row.uiStatus !== 'Disabled') return false
    if (filters.quickFilter === 'problem' && (row.uiStatus === 'Healthy' || row.uiStatus === 'Idle')) return false
    if (filters.highErr && (!row.metrics || row.metrics.success_rate >= 95)) return false
    if (filters.highLat && (!row.metrics || row.metrics.avg_latency_ms <= 200)) return false
    return true
  })
}
