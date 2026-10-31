import type { OperationalHealthStatus } from '../api/operationalSnapshot'
import type { StreamRuntimeStatus } from '../api/streamRows'

/**
 * Operator-facing severity. `unknown` is frontend-only: the stream is active but there is
 * no evidence for a verdict yet (no evidence is not Healthy; zero traffic is not a failure).
 */
export type StreamOperationalSeverity = 'healthy' | 'warning' | 'critical' | 'stopped' | 'unknown'

export type StreamSeverityInput = {
  status: StreamRuntimeStatus
  routesError: number
  routesDegraded?: number
  deliveryPctKnown: boolean
  deliveryPct: number
  /** Operational snapshot health; IDLE means "no health verdict". */
  operationalHealthStatus?: OperationalHealthStatus | null
  /** True when a runtime API body (snapshot/stats/health) exists for this stream. */
  hasRuntimeApiSnapshot?: boolean
}

export type PartialStreamSeverityInput = {
  status: StreamRuntimeStatus
  routesError?: number
  routesDegraded?: number
  deliveryPctKnown?: boolean
  deliveryPct?: number
  operationalHealthStatus?: OperationalHealthStatus | null
  hasRuntimeApiSnapshot?: boolean
}

export function normalizeSeverityInput(row: PartialStreamSeverityInput): StreamSeverityInput {
  // A delivery percentage is known only when it was actually reported; never assume 100%.
  const deliveryPctKnown = (row.deliveryPctKnown ?? false) && typeof row.deliveryPct === 'number'
  return {
    status: row.status,
    routesError: row.routesError ?? 0,
    routesDegraded: row.routesDegraded ?? 0,
    deliveryPctKnown,
    deliveryPct: row.deliveryPct ?? 0,
    operationalHealthStatus: row.operationalHealthStatus ?? null,
    hasRuntimeApiSnapshot: row.hasRuntimeApiSnapshot,
  }
}

/** Operator-facing severity — not identical to raw backend status. */
export function effectiveStreamSeverity(row: StreamSeverityInput): StreamOperationalSeverity {
  if (row.status === 'ERROR') return 'critical'
  if (row.status === 'STOPPED') return 'stopped'
  if (row.status === 'IDLE') return 'stopped'
  if ((row.routesError ?? 0) > 0) return 'warning'
  if (row.status === 'DEGRADED' && row.deliveryPctKnown && row.deliveryPct < 95) return 'warning'
  if (row.status === 'DEGRADED' && !row.deliveryPctKnown) return 'warning'
  if (row.deliveryPctKnown && row.deliveryPct < 90) return 'warning'
  // Snapshot says "no verdict" for an active (RUNNING/UNKNOWN) stream: not observed yet.
  if ((row.status === 'RUNNING' || row.status === 'UNKNOWN') && row.operationalHealthStatus === 'IDLE') {
    return 'unknown'
  }
  // No runtime evidence source at all and no known delivery outcome.
  const hasEvidenceSource = row.hasRuntimeApiSnapshot === true || row.operationalHealthStatus != null
  if ((row.status === 'RUNNING' || row.status === 'UNKNOWN') && !hasEvidenceSource && !row.deliveryPctKnown) {
    return 'unknown'
  }
  return 'healthy'
}

export function severityToRuntimeStatus(severity: StreamOperationalSeverity): StreamRuntimeStatus {
  switch (severity) {
    case 'critical':
      return 'ERROR'
    case 'warning':
      return 'DEGRADED'
    case 'stopped':
      return 'STOPPED'
    case 'unknown':
      return 'UNKNOWN'
    default:
      return 'RUNNING'
  }
}

const SEVERITY_RANK: Record<StreamOperationalSeverity, number> = {
  healthy: 0,
  stopped: 1,
  unknown: 2,
  warning: 3,
  critical: 4,
}

export function worstOperationalSeverity(severities: readonly StreamOperationalSeverity[]): StreamOperationalSeverity {
  let worst: StreamOperationalSeverity = 'healthy'
  let rank = -1
  for (const s of severities) {
    const r = SEVERITY_RANK[s] ?? 0
    if (r > rank) {
      rank = r
      worst = s
    }
  }
  return worst
}

export function countOperationalIssues(rows: readonly PartialStreamSeverityInput[]): number {
  return rows.filter((r) => {
    const s = effectiveStreamSeverity(normalizeSeverityInput(r))
    return s === 'warning' || s === 'critical'
  }).length
}

export function operationalSeverityIcon(
  severity: StreamOperationalSeverity,
): 'ok' | 'warn' | 'critical' | 'stopped' | 'unknown' {
  switch (severity) {
    case 'critical':
      return 'critical'
    case 'warning':
      return 'warn'
    case 'stopped':
      return 'stopped'
    case 'unknown':
      return 'unknown'
    default:
      return 'ok'
  }
}
