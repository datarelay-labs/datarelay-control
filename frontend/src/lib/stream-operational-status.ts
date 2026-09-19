import type { StreamRuntimeStatus } from '../api/streamRows'

export type StreamOperationalSeverity = 'healthy' | 'warning' | 'critical' | 'stopped'

export type StreamSeverityInput = {
  status: StreamRuntimeStatus
  routesError: number
  routesDegraded?: number
  deliveryPctKnown: boolean
  deliveryPct: number
}

export type PartialStreamSeverityInput = {
  status: StreamRuntimeStatus
  routesError?: number
  routesDegraded?: number
  deliveryPctKnown?: boolean
  deliveryPct?: number
}

export function normalizeSeverityInput(row: PartialStreamSeverityInput): StreamSeverityInput {
  return {
    status: row.status,
    routesError: row.routesError ?? 0,
    routesDegraded: row.routesDegraded ?? 0,
    deliveryPctKnown: row.deliveryPctKnown ?? false,
    deliveryPct: row.deliveryPct ?? 100,
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
    default:
      return 'RUNNING'
  }
}

const SEVERITY_RANK: Record<StreamOperationalSeverity, number> = {
  healthy: 0,
  stopped: 1,
  warning: 2,
  critical: 3,
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

export function operationalSeverityIcon(severity: StreamOperationalSeverity): 'ok' | 'warn' | 'critical' | 'stopped' {
  switch (severity) {
    case 'critical':
      return 'critical'
    case 'warning':
      return 'warn'
    case 'stopped':
      return 'stopped'
    default:
      return 'ok'
  }
}
