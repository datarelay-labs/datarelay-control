import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import {
  computeSuccessRateFromEps,
  formatOperationalEps,
  formatOperationalSuccessRate,
  selectDestinationKpi,
  selectRouteKpi,
} from '../../lib/operational-snapshot-selectors'
import {
  formatEps,
  formatSuccessRate,
  relativeShort,
  routePublicId,
  type RouteConsoleRow,
  type RouteUiStatus,
} from './routes-overview-helpers'

export type RouteFlowRouteRow = {
  routeId: number
  routeLabel: string
  destinationId: number | null
  destinationName: string
  eps: number | null
  successRatePct: number | null
  errorRatePct: number | null
  health: RouteUiStatus
  enabled: boolean
}

export type RouteFlowStreamGroup = {
  streamId: number
  streamName: string
  connectorId: number | null
  sourceId: number | null
  totalEps: number | null
  routes: RouteFlowRouteRow[]
}

/**
 * Operator-facing attention is based on the existing route snapshot health,
 * not configured status alone and never on summed fan-out throughput.
 */
export type RouteFlowAttentionItem = {
  streamId: number
  streamName: string
  routeId: number
  destinationName: string
  status: 'Error' | 'Warning'
}

export function listRouteFlowAttention(groups: readonly RouteFlowStreamGroup[]): RouteFlowAttentionItem[] {
  const items: RouteFlowAttentionItem[] = []
  for (const group of groups) {
    for (const route of group.routes) {
      if (!route.enabled || (route.health !== 'Error' && route.health !== 'Warning')) continue
      items.push({
        streamId: group.streamId,
        streamName: group.streamName,
        routeId: route.routeId,
        destinationName: route.destinationName,
        status: route.health,
      })
    }
  }
  // Errors first, then warnings. Use stable numeric identities for equal-severity
  // items so duplicate names cannot hijack Route selection.
  return items.sort((a, b) =>
    (a.status === 'Error' ? 0 : 1) - (b.status === 'Error' ? 0 : 1) ||
    a.streamId - b.streamId ||
    a.routeId - b.routeId,
  )
}

export type ProblemRouteRow = {
  routeId: number
  routeLabel: string
  streamName: string
  destinationName: string
  issue: string
  severity: number
  throughputEps: number | null
  since: string | null
}

export type DestinationRouteMetricRow = {
  destinationId: number
  destinationName: string
  connectedRoutes: number
  throughputEps: number | null
  successRatePct: number | null
}

const HIGH_LATENCY_MS = 200
const LOW_SUCCESS_RATE_PCT = 95
export const PROBLEM_ROUTES_LIMIT = 8

function errorRateFromSuccess(successRatePct: number | null, delivered: number, failed: number): number | null {
  if (successRatePct != null && Number.isFinite(successRatePct)) {
    return Math.round((100 - successRatePct) * 100) / 100
  }
  const inverse = computeSuccessRateFromEps(failed, delivered)
  return inverse != null ? Math.round((100 - inverse) * 100) / 100 : null
}

function routeFlowRowFromConsole(row: RouteConsoleRow): RouteFlowRouteRow {
  const m = row.metrics
  const delivered = m?.eps_current ?? null
  const successRatePct = m?.success_rate ?? null
  return {
    routeId: row.route.id,
    routeLabel: row.routeLabel,
    destinationId: Number.isSafeInteger(row.route.destination_id) && (row.route.destination_id ?? 0) > 0
      ? row.route.destination_id
      : null,
    destinationName: (row.destination?.name ?? '').trim() || `Destination #${row.route.destination_id ?? '—'}`,
    eps: delivered,
    successRatePct,
    errorRatePct: errorRateFromSuccess(successRatePct, m?.delivered_last_hour ?? 0, m?.failed_last_hour ?? 0),
    health: row.uiStatus,
    enabled: row.route.enabled !== false,
  }
}

/** Group operational snapshot routes by stream for the flow tree. */
export function buildRouteFlowTree(
  snapshot: OperationalSnapshotResponse | null,
  consoleRows: readonly RouteConsoleRow[],
): RouteFlowStreamGroup[] {
  if (snapshot == null || consoleRows.length === 0) return []

  const validId = (id: unknown): id is number =>
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0
  const streamsById = new Map((snapshot.streams ?? [])
    .filter((s) => validId(s.stream_id))
    .map((s) => [s.stream_id, s]))
  const byStream = new Map<number, RouteFlowStreamGroup>()
  const seenRoutes = new Set<number>()
  for (const row of consoleRows) {
    // The graph must not manufacture edges for invalid or duplicate identifiers.
    const sid = row.stream?.id ?? row.route.stream_id
    if (!validId(sid) || !validId(row.route.id) || seenRoutes.has(row.route.id)) continue
    seenRoutes.add(row.route.id)
    const streamName = (row.stream?.name ?? '').trim() || `Stream #${sid}`
    let group = byStream.get(sid)
    if (group == null) {
      group = {
        streamId: sid,
        streamName,
        connectorId: validId(streamsById.get(sid)?.connector_id) ? streamsById.get(sid)!.connector_id : null,
        sourceId: validId(streamsById.get(sid)?.source_id) ? streamsById.get(sid)!.source_id : null,
        totalEps: Number.isFinite(streamsById.get(sid)?.eps_1m) ? streamsById.get(sid)!.eps_1m : null,
        routes: [],
      }
      byStream.set(sid, group)
    }
    group.routes.push(routeFlowRowFromConsole(row))
  }

  return [...byStream.values()]
    .map((g) => ({
      ...g,
      // Stream EPS is ingest truth. Never substitute the sum of per-route
      // delivered EPS because fan-out can make those values incomparable.
      routes: [...g.routes].sort((a, b) => (b.eps ?? 0) - (a.eps ?? 0)),
    }))
    .sort((a, b) => (b.totalEps ?? 0) - (a.totalEps ?? 0))
}

function problemSeverity(issue: string): number {
  switch (issue) {
    case 'Error':
      return 4
    case 'Warning':
      return 3
    case 'High Latency':
      return 2
    case 'Low Success Rate':
      return 1
    default:
      return 0
  }
}

function detectRouteIssue(row: RouteConsoleRow): string | null {
  if (row.uiStatus === 'Error') return 'Error'
  if (row.uiStatus === 'Warning') return 'Warning'
  const m = row.metrics
  if (!m) return null
  if (m.success_rate < LOW_SUCCESS_RATE_PCT) return 'Low Success Rate'
  if (m.avg_latency_ms > HIGH_LATENCY_MS) return 'High Latency'
  return null
}

/** Routes with operational issues for the problem panel (top N by severity). */
export function buildProblemRoutes(
  consoleRows: readonly RouteConsoleRow[],
  limit = PROBLEM_ROUTES_LIMIT,
): ProblemRouteRow[] {
  const problems: ProblemRouteRow[] = []
  for (const row of consoleRows) {
    const issue = detectRouteIssue(row)
    if (issue == null) continue
    const m = row.metrics
    problems.push({
      routeId: row.route.id,
      routeLabel: row.routeLabel,
      streamName: (row.stream?.name ?? '').trim() || `Stream #${row.route.stream_id ?? '—'}`,
      destinationName: (row.destination?.name ?? '').trim() || `Destination #${row.route.destination_id ?? '—'}`,
      issue,
      severity: problemSeverity(issue),
      throughputEps: m?.eps_current ?? null,
      since: m?.last_failure_at ?? m?.last_success_at ?? null,
    })
  }
  return problems
    .sort((a, b) => b.severity - a.severity || (b.throughputEps ?? 0) - (a.throughputEps ?? 0))
    .slice(0, limit)
}

/** Destination-level throughput and success from operational snapshot. */
export function buildDestinationRouteMetrics(
  snapshot: OperationalSnapshotResponse | null,
  consoleRows: readonly RouteConsoleRow[],
): DestinationRouteMetricRow[] {
  if (snapshot == null) return []

  const routeCountByDest = new Map<number, number>()
  for (const row of consoleRows) {
    const did = row.destination?.id ?? row.route.destination_id
    if (typeof did !== 'number') continue
    routeCountByDest.set(did, (routeCountByDest.get(did) ?? 0) + 1)
  }

  const problems = snapshot.problems ?? []
  const rows: DestinationRouteMetricRow[] = (snapshot.destinations ?? []).map((dest) => {
    const kpi = selectDestinationKpi(dest, problems)
    return {
      destinationId: dest.destination_id,
      destinationName: (dest.destination_name ?? '').trim() || `Destination #${dest.destination_id}`,
      connectedRoutes: routeCountByDest.get(dest.destination_id) ?? dest.route_count ?? 0,
      throughputEps: kpi.inboundEps1m,
      successRatePct: kpi.successRatePct,
    }
  })

  return rows
    .filter((r) => r.connectedRoutes > 0 || (r.throughputEps ?? 0) > 0)
    .sort((a, b) => (b.throughputEps ?? 0) - (a.throughputEps ?? 0))
}

/** A snapshot is evidence only while its origin timestamp is recent and parseable. */
export function isRouteSnapshotStale(updatedAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!updatedAt) return true
  const ms = Date.parse(updatedAt)
  return !Number.isFinite(ms) || ms > nowMs + 60_000 || nowMs - ms > 90_000
}

export function formatFlowEps(eps: number | null | undefined): string {
  return formatEps(eps)
}

export function formatFlowSuccessRate(pct: number | null | undefined): string {
  return formatSuccessRate(pct)
}

export function formatFlowErrorRate(pct: number | null | undefined): string {
  return formatSuccessRate(pct)
}

export function routeHealthBadgeClass(health: RouteUiStatus): string {
  switch (health) {
    case 'Healthy':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
    case 'Warning':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100'
    case 'Error':
      return 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200'
    case 'Disabled':
      return 'border-slate-300/80 bg-slate-100 text-slate-600 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted'
    default:
      return 'border-slate-300/80 bg-slate-100 text-slate-600 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted'
  }
}

export function aggregateGlobalErrorRateFromRoutes(snapshot: OperationalSnapshotResponse | null): number | null {
  if (snapshot == null) return null
  let delivered = 0
  let failed = 0
  for (const r of snapshot.routes ?? []) {
    delivered += r.delivered_eps_1m ?? 0
    failed += r.failed_eps_1m ?? 0
  }
  const total = delivered + failed
  if (total <= 0) return null
  return Math.round((100 * failed) / total * 100) / 100
}

export { formatOperationalEps, formatOperationalSuccessRate, relativeShort, routePublicId, selectRouteKpi }
