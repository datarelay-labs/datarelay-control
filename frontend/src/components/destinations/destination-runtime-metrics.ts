import type { DestinationListItem } from '../../api/gdcDestinations'
import type { StreamsMetricsWindow } from '../../constants/streamConsoleFilters'
import { streamsTimeRangeLabel } from '../../constants/streamConsoleFilters'
import type {
  OperationalDestinationSnapshot,
  OperationalSnapshotResponse,
} from '../../api/operationalSnapshot'
import type {
  DestinationDeliveryOutcomeRow,
  DestinationHealthRow,
  HealthLevel,
  RouteFailuresAnalyticsResponse,
  RouteHealthRow,
  RuntimeLogSearchItem,
} from '../../api/types/gdcApi'
import {
  computeSuccessRateFromEps,
  selectDestinationKpi,
  selectRouteKpi,
  type OperationalUiHealthLabel,
} from '../../lib/operational-snapshot-selectors'
import { operationalFactorTags } from '../../lib/operational-health-present'
import { resolveDestinationListUiHealth } from '../../utils/destination-connectivity-health'
import { extractCapacityConfig } from './destination-mini-charts'

export type DestinationUiHealth = OperationalUiHealthLabel

export type DestinationRuntimeLookup = {
  snapshot: OperationalDestinationSnapshot | null
  kpi: ReturnType<typeof selectDestinationKpi> | null
}

export type DestinationListRuntimeMetrics = {
  connectedStreams: number
  connectedRoutes: number
  successRatePct: number | null
  currentEps: number | null
  /** Snapshot 1m capacity usage used by operational capacity-warning drill-downs. */
  capacityUsagePct?: number | null
  capacityWarning?: boolean
  /** True when the selected window has at least one delivered or failed event. */
  hasDeliveryActivity: boolean
  health: DestinationUiHealth
  recentIssues: string[]
  metricsWindowLabel: string
}

const METRICS_WINDOW_SECONDS: Record<StreamsMetricsWindow, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
}

export function destinationMetricsWindowSeconds(window: StreamsMetricsWindow): number {
  return METRICS_WINDOW_SECONDS[window] ?? METRICS_WINDOW_SECONDS['1h']
}

export function destinationRuntimeWindowLabel(window: StreamsMetricsWindow = '1h'): string {
  return streamsTimeRangeLabel(window).replace(/^Last\s+/i, '')
}

function healthLevelToUiHealth(level: HealthLevel): DestinationUiHealth {
  switch (level) {
    case 'HEALTHY':
      return 'Healthy'
    case 'DEGRADED':
      return 'Warning'
    case 'UNHEALTHY':
    case 'CRITICAL':
      return 'Critical'
    default:
      return 'Idle'
  }
}

export function destinationDeliveryMetricsFromHealthRow(
  healthRow: DestinationHealthRow | null,
  timeRange: StreamsMetricsWindow,
): Pick<DestinationListRuntimeMetrics, 'successRatePct' | 'currentEps' | 'hasDeliveryActivity'> {
  if (!healthRow) {
    return { successRatePct: null, currentEps: null, hasDeliveryActivity: false }
  }
  const success = safeNonNeg(healthRow.metrics.success_count)
  const failure = safeNonNeg(healthRow.metrics.failure_count)
  const total = success + failure
  if (total <= 0) {
    return { successRatePct: null, currentEps: null, hasDeliveryActivity: false }
  }
  const windowSec = destinationMetricsWindowSeconds(timeRange)
  return {
    successRatePct: Math.round((100 * success) / total * 100) / 100,
    currentEps: total / windowSec,
    hasDeliveryActivity: true,
  }
}

export function destinationIssuesForListRow(
  row: DestinationListItem,
  healthRow: DestinationHealthRow | null,
  snapshotIssues: readonly string[] = [],
): string[] {
  const issues: string[] = []
  if (row.last_connectivity_test_success === false) {
    const probeMsg = row.last_connectivity_test_message?.trim()
    issues.push(probeMsg || 'Connectivity test failed')
  }
  for (const tag of operationalFactorTags(healthRow?.factors)) {
    if (!issues.includes(tag)) issues.push(tag)
  }
  for (const factor of healthRow?.factors ?? []) {
    const detail = factor.detail?.trim()
    if (detail && !issues.includes(detail)) issues.push(detail)
  }
  for (const issue of snapshotIssues) {
    if (issue && !issues.includes(issue)) issues.push(issue)
  }
  return issues.slice(0, 3)
}

export function destinationUiHealthForListRow(
  row: DestinationListItem,
  healthRow: DestinationHealthRow | null,
  snapshot: OperationalDestinationSnapshot | null,
  snapshotLabel: OperationalUiHealthLabel | undefined,
): DestinationUiHealth {
  if (!row.enabled) return 'Disabled'
  if (row.last_connectivity_test_success === false) return 'Critical'
  if (healthRow) return healthLevelToUiHealth(healthRow.level)
  return resolveDestinationListUiHealth(row, snapshot, snapshotLabel)
}

function safeNonNeg(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return x
}

function aggregateDestinationDeliveryFromRoutes(
  destinationId: number,
  snapshot: OperationalSnapshotResponse | null | undefined,
): { inboundEps: number; failedEps: number; hasData: boolean } {
  const routes = (snapshot?.routes ?? []).filter((route) => route.destination_id === destinationId)
  if (routes.length === 0) {
    return { inboundEps: 0, failedEps: 0, hasData: false }
  }
  let inboundEps = 0
  let failedEps = 0
  for (const route of routes) {
    inboundEps += safeNonNeg(route.delivered_eps_1m)
    failedEps += safeNonNeg(route.failed_eps_1m)
  }
  return { inboundEps, failedEps, hasData: true }
}

function resolveDestinationDeliveryMetrics(
  destinationId: number,
  kpi: ReturnType<typeof selectDestinationKpi> | null,
  snapshot: OperationalSnapshotResponse | null | undefined,
): { successRatePct: number | null; currentEps: number | null; hasDeliveryActivity: boolean } {
  const routeDelivery = aggregateDestinationDeliveryFromRoutes(destinationId, snapshot)
  const inboundEps = routeDelivery.hasData ? routeDelivery.inboundEps : kpi?.inboundEps1m ?? null
  const failedEps = routeDelivery.hasData ? routeDelivery.failedEps : kpi?.failedEps1m ?? null
  const inbound = inboundEps ?? 0
  const failed = failedEps ?? 0
  const total = inbound + failed
  if (total <= 0) {
    return { successRatePct: null, currentEps: null, hasDeliveryActivity: false }
  }
  return {
    successRatePct: computeSuccessRateFromEps(inbound, failed),
    currentEps: inbound,
    hasDeliveryActivity: true,
  }
}

export function resolveDestinationUiHealth(
  enabled: boolean,
  snapshot: OperationalDestinationSnapshot | null,
  _health: DestinationHealthRow | null = null,
): DestinationUiHealth {
  if (!enabled) return 'Disabled'
  if (snapshot == null) return 'Idle'
  return selectDestinationKpi(snapshot).health.label
}

/** Historical success counts are fetched for the selected 24h window.
 * Instantaneous 1m Destination EPS cannot legitimately stand in for 24h success.
 */
export function computeDestinationSuccessRate(
  health: DestinationHealthRow | null,
  outcome: DestinationDeliveryOutcomeRow | null,
  _snapshot: OperationalDestinationSnapshot | null,
): number | null {
  const success = outcome != null ? outcome.success_events : health?.metrics?.success_count
  const failures = outcome != null ? outcome.failure_events : health?.metrics?.failure_count
  if (typeof success !== 'number' || typeof failures !== 'number' ||
      !Number.isFinite(success) || !Number.isFinite(failures) || success < 0 || failures < 0) {
    return null
  }
  const total = success + failures
  return Number.isFinite(total) && total > 0 ? Math.round((10000 * success) / total) / 100 : null
}

export function computeDestinationCurrentEps(snapshot: OperationalDestinationSnapshot | null): number | null {
  if (snapshot == null) return null
  return selectDestinationKpi(snapshot).inboundEps1m
}

export function buildDestinationRuntimeLookup(
  snapshot: OperationalSnapshotResponse | null,
): Map<number, DestinationRuntimeLookup> {
  const snapById = new Map<number, OperationalDestinationSnapshot>()
  for (const row of snapshot?.destinations ?? []) snapById.set(row.destination_id, row)

  const problems = snapshot?.problems ?? []
  const out = new Map<number, DestinationRuntimeLookup>()
  for (const [id, snap] of snapById) {
    out.set(id, {
      snapshot: snap,
      kpi: selectDestinationKpi(snap, problems),
    })
  }
  return out
}

export function listRuntimeMetricsForDestination(
  row: DestinationListItem,
  lookup: Map<number, DestinationRuntimeLookup>,
  snapshot: OperationalSnapshotResponse | null = null,
  healthRow: DestinationHealthRow | null = null,
  timeRange: StreamsMetricsWindow = '1h',
): DestinationListRuntimeMetrics {
  const runtime = lookup.get(row.id) ?? { snapshot: null, kpi: null }
  const kpi = runtime.kpi
  const connectedRoutes = row.routes?.length ?? 0
  const connectedStreams = row.streams_using_count ?? 0
  const snapshotLabel = kpi?.health.label
  const healthDelivery = destinationDeliveryMetricsFromHealthRow(healthRow, timeRange)
  const snapshotDelivery =
    healthDelivery.hasDeliveryActivity
      ? healthDelivery
      : resolveDestinationDeliveryMetrics(row.id, kpi, snapshot)
  const { limitEps, thresholds } = extractCapacityConfig(row)
  const snapshotEps = runtime.snapshot?.inbound_eps_1m ?? null
  const capacityUsagePct =
    limitEps != null && limitEps > 0 && snapshotEps != null && Number.isFinite(snapshotEps)
      ? (snapshotEps / limitEps) * 100
      : null
  return {
    connectedStreams,
    connectedRoutes,
    successRatePct: snapshotDelivery.successRatePct,
    currentEps: snapshotDelivery.currentEps,
    capacityUsagePct,
    capacityWarning: capacityUsagePct != null && capacityUsagePct >= thresholds.warningPct,
    hasDeliveryActivity: snapshotDelivery.hasDeliveryActivity,
    health: destinationUiHealthForListRow(row, healthRow, runtime.snapshot, snapshotLabel),
    recentIssues: destinationIssuesForListRow(row, healthRow, kpi?.issues ?? []),
    metricsWindowLabel: destinationRuntimeWindowLabel(timeRange),
  }
}

export function connectedStreamIdsFromRoutes(routes: DestinationListItem['routes']): number[] {
  const ids = new Set<number>()
  for (const r of routes ?? []) {
    if (typeof r.stream_id === 'number') ids.add(r.stream_id)
  }
  return [...ids]
}

export function mapLogToDeliveryActivity(log: RuntimeLogSearchItem, routeNameById: Map<number, string>) {
  // A retry counter is not the final delivery outcome. Only a stated
  // outcome is success: unknown/queued records must not become green.
  const statusRaw = String(log.status ?? '').trim().toUpperCase()
  let status: 'SUCCESS' | 'RETRY' | 'FAILED' | 'UNKNOWN' = 'UNKNOWN'
  if (statusRaw === 'FAILED' || statusRaw === 'FAILURE' || statusRaw.endsWith('_FAILED') || log.level?.toUpperCase() === 'ERROR') {
    status = 'FAILED'
  } else if (statusRaw === 'RETRY' || statusRaw === 'RETRYING' || statusRaw === 'RETRY_PENDING') {
    status = 'RETRY'
  } else if (statusRaw === 'OK' || statusRaw === 'SUCCESS' || statusRaw === 'SUCCEEDED' || statusRaw === 'DELIVERED') {
    status = 'SUCCESS'
  }

  const routeId = log.route_id != null && Number.isSafeInteger(log.route_id) && log.route_id > 0 ? log.route_id : null
  const streamId = log.stream_id != null && Number.isSafeInteger(log.stream_id) && log.stream_id > 0 ? log.stream_id : null
  const routeLabel = routeId != null ? routeNameById.get(routeId) ?? `Route #${routeId}` : '—'

  return {
    id: String(log.id),
    time: log.created_at?.slice(0, 19).replace('T', ' ') ?? '—',
    routeId,
    streamId,
    routeName: routeLabel,
    status,
    events: 1,
    latencyMs: typeof log.latency_ms === 'number' && Number.isFinite(log.latency_ms) && log.latency_ms >= 0
      ? Math.round(log.latency_ms) : null,
    message: (log.message ?? log.error_code ?? '—').trim() || '—',
  }
}

export function mapLogToRecentFailure(log: RuntimeLogSearchItem, routeNameById: Map<number, string>) {
  const code = (log.error_code ?? 'DELIVERY_ERROR').toUpperCase()
  const allowed = ['TIMEOUT', 'CONN_REFUSED', 'RATE_LIMIT', 'TLS_HANDSHAKE'] as const
  const normalized = allowed.includes(code as (typeof allowed)[number])
    ? (code as (typeof allowed)[number])
    : ('UNCLASSIFIED' as const)

  return {
    id: String(log.id),
    at: log.created_at?.slice(0, 19).replace('T', ' ') ?? '—',
    code: normalized,
    routeName:
      log.route_id != null
        ? routeNameById.get(log.route_id) ?? `Route #${log.route_id}`
        : '—',
    failedEvents: 1,
    message: (log.message ?? '').trim(),
  }
}

export function routeMetricsFromSnapshot(
  routeId: number,
  snapshotRoutes: OperationalSnapshotResponse['routes'] | null | undefined,
  problems: OperationalSnapshotResponse['problems'] | null | undefined,
): {
  epsAvg: number
  /** 5-minute operational snapshot, not a 24-hour historical success metric. */
  successRate5m: number | null
  status: 'ACTIVE' | 'PAUSED' | 'ERROR'
  deliveryMode: string
} {
  const snap = (snapshotRoutes ?? []).find((r) => r.route_id === routeId)
  if (snap == null) {
    return { epsAvg: 0, successRate5m: null, status: 'ACTIVE', deliveryMode: '—' }
  }
  const kpi = selectRouteKpi(snap, problems ?? [])
  // A reported 0% with no recent outcome sample is ambiguous: never render it
  // as verified failed-only delivery. Keep a genuine 0% where failures exist.
  const hasRecentSample = (Number.isFinite(snap.delivered_eps_1m) && snap.delivered_eps_1m > 0) ||
    (Number.isFinite(snap.failed_eps_1m) && snap.failed_eps_1m > 0)
  const successRate5m = kpi.successRatePct == null || (kpi.successRatePct === 0 && !hasRecentSample)
    ? null : kpi.successRatePct

  let status: 'ACTIVE' | 'PAUSED' | 'ERROR' = 'ACTIVE'
  if (!snap.enabled) status = 'PAUSED'
  else if (snap.health_status === 'ERROR') status = 'ERROR'

  return {
    epsAvg: snap.delivered_eps_1m ?? 0,
    successRate5m,
    status,
    deliveryMode: snap.failure_policy?.trim() || '—',
  }
}

/** @deprecated Prefer routeMetricsFromSnapshot — _routeHealth is unused (snapshot-owned EPS/status). */
export function routeMetricsFromHealthAndSnapshot(
  routeId: number,
  _streamName: string,
  _streamId: number,
  _routeHealth: RouteHealthRow | null,
  snapshotRoutes: OperationalSnapshotResponse['routes'] | null | undefined,
  problems?: OperationalSnapshotResponse['problems'] | null | undefined,
) {
  return routeMetricsFromSnapshot(routeId, snapshotRoutes, problems)
}

export function failureCountFromAnalytics(failures: RouteFailuresAnalyticsResponse | null): number | null {
  // Missing/failed historical analytics is not evidence of zero delivery failures.
  const count = failures?.totals?.failure_events
  return typeof count === 'number' && Number.isFinite(count) && count >= 0
    ? Math.floor(count)
    : null
}
