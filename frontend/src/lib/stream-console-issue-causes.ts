import type { StreamConsoleRow } from '../api/streamRows'
import type { StreamsMetricsWindow } from '../constants/streamConsoleFilters'
import {
  effectiveStreamSeverity,
  normalizeSeverityInput,
  type StreamOperationalSeverity,
} from './stream-operational-status'

/** Operator-facing issue cause labels shown in the Streams console Issues column. */
export type StreamIssueCauseLabel =
  | `No Data (${string})`
  | 'Schema Drift'
  | 'Destination Error'
  | 'Checkpoint Error'
  | 'Protection Block'
  | 'Source Error'
  | 'Low Volume'

/** Operator priority — lower rank = shown first. */
const ISSUE_CAUSE_RANK: readonly { match: (cause: string) => boolean; rank: number }[] = [
  { match: (c) => c === 'Protection Block', rank: 0 },
  { match: (c) => c === 'Destination Error', rank: 1 },
  { match: (c) => c === 'Source Error', rank: 2 },
  { match: (c) => c === 'Checkpoint Error', rank: 3 },
  { match: (c) => c.startsWith('No Data'), rank: 4 },
  { match: (c) => c === 'Schema Drift', rank: 5 },
  { match: (c) => c === 'Low Volume', rank: 6 },
]

const LOW_VOLUME_EVENT_THRESHOLD = 50

export function issueCauseRank(cause: string): number {
  for (const entry of ISSUE_CAUSE_RANK) {
    if (entry.match(cause)) return entry.rank
  }
  return 99
}

export function sortIssueCausesByPriority(causes: readonly string[]): string[] {
  return [...causes].sort((a, b) => {
    const rankDelta = issueCauseRank(a) - issueCauseRank(b)
    if (rankDelta !== 0) return rankDelta
    return a.localeCompare(b)
  })
}

export function formatIssuesDisplay(causes: readonly string[], maxVisible = 2): string {
  if (!causes.length) return '—'
  const sorted = sortIssueCausesByPriority(causes)
  if (sorted.length <= maxVisible) return sorted.join(' · ')
  const visible = sorted.slice(0, maxVisible)
  const hidden = sorted.length - maxVisible
  return `${visible.join(' · ')} +${hidden}`
}

export function streamsWindowChip(window: StreamsMetricsWindow): string {
  return window
}

/** Informational stale-checkpoint signal from operational snapshot (not a delivery failure). */
export function isCheckpointStaleLagMessage(issue: string): boolean {
  const trimmed = issue.trim()
  if (!trimmed) return false
  const lower = trimmed.toLowerCase()
  return /^checkpoint lag:\s*\d/i.test(trimmed) || lower.includes('checkpoint is stale')
}

function isCheckpointFailureMessage(issue: string): boolean {
  const lower = issue.trim().toLowerCase()
  if (!lower || isCheckpointStaleLagMessage(issue)) return false
  if (/checkpoint.*(fail|error|stalled|unable|refused)/i.test(lower)) return true
  if (/checkpoint_update/i.test(lower)) return true
  return false
}

function normalizeRuntimeIssueLabel(runtimeIssue: string): StreamIssueCauseLabel | null {
  const issue = runtimeIssue.trim()
  if (!issue) return null
  const lower = issue.toLowerCase()

  if (lower.includes('stream delivery degraded')) return null
  if (lower.includes('destination error') || lower.includes('destination delivery error')) return 'Destination Error'
  if (isCheckpointFailureMessage(issue)) return 'Checkpoint Error'
  if (lower.includes('protection') || lower.includes('quarantine') || lower.includes('blocked')) return 'Protection Block'
  if (lower.includes('schema') || lower.includes('drift')) return 'Schema Drift'
  if (lower.includes('source error') || lower.includes('extract') || lower.includes('rate limit') || lower.includes('429')) {
    return 'Source Error'
  }

  return null
}

function recentErrorMatches(row: StreamConsoleRow, pattern: RegExp): boolean {
  return row.recentErrors.some((e) => pattern.test(`${e.message} ${e.relativeAt}`))
}

function hasDestinationFailureSignal(row: StreamConsoleRow): boolean {
  if (row.runtimeIssue && /destination|delivery|route[_\s-]?(send|retry)/i.test(row.runtimeIssue)) return true
  return recentErrorMatches(row, /destination|delivery|route[_\s-]?(send|retry)|webhook|syslog/i)
}

/** Derive concrete issue causes for a stream console row (snapshot-enriched runtime fields). */
export function deriveStreamIssueCauses(
  row: StreamConsoleRow,
  metricsWindow: StreamsMetricsWindow,
): StreamIssueCauseLabel[] {
  const causes: string[] = []
  const windowChip = streamsWindowChip(metricsWindow)

  if (row.runtimeIssue) {
    const normalizedRuntimeIssue = normalizeRuntimeIssueLabel(row.runtimeIssue)
    const deliveryFine =
      row.routesError === 0 &&
      row.deliveryPctKnown &&
      row.deliveryPct >= 95 &&
      /delivery degraded/i.test(row.runtimeIssue)
    if (!deliveryFine && normalizedRuntimeIssue) {
      causes.push(normalizedRuntimeIssue)
    }
  }

  if (row.hasRuntimeApiSnapshot) {
    if (row.status === 'ERROR' || row.routesError > 0) {
      causes.push('Destination Error')
    } else if (
      row.deliveryPctKnown &&
      row.deliveryPct < 90 &&
      (row.events1h > 0 || (row.eps1m != null && row.eps1m > 0)) &&
      hasDestinationFailureSignal(row)
    ) {
      causes.push('Destination Error')
    }

    if (row.status === 'STOPPED') {
      // Explicit runtime/scheduler stop — do not mislabel as No Data.
    } else if (row.status === 'IDLE' && row.enabled !== false) {
      causes.push(`No Data (${windowChip})`)
    } else if (row.events1h > 0 && row.events1h < LOW_VOLUME_EVENT_THRESHOLD) {
      causes.push('Low Volume')
    }
  } else {
    causes.push(`No Data (${windowChip})`)
  }

  if (
    recentErrorMatches(row, /checkpoint.*(fail|error|stalled|unable|refused)|checkpoint_update/i) ||
    /stalled|behind/i.test(row.checkpointLagLabel)
  ) {
    causes.push('Checkpoint Error')
  }

  if (recentErrorMatches(row, /protection|protected|quarantine|blocked/i)) {
    causes.push('Protection Block')
  }

  if (recentErrorMatches(row, /schema|drift/i)) {
    causes.push('Schema Drift')
  }

  const sourceLikely =
    row.status === 'DEGRADED' &&
    row.routesError === 0 &&
    row.routesDegraded === 0 &&
    recentErrorMatches(row, /source|extract|rate.?limit|429|poll/i)
  if (sourceLikely) {
    causes.push('Source Error')
  }

  return sortIssueCausesByPriority([...new Set(causes)]) as StreamIssueCauseLabel[]
}

export function streamOperationalHealthLabel(severity: StreamOperationalSeverity): 'Healthy' | 'Warning' | 'Critical' | 'Stopped' {
  switch (severity) {
    case 'critical':
      return 'Critical'
    case 'warning':
      return 'Warning'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Healthy'
  }
}

/** Streams Console status chip — Stopped vs Disabled vs No Data must not collapse. */
export function streamConsoleLifecycleLabel(row: StreamConsoleRow): 'Healthy' | 'Warning' | 'Critical' | 'Stopped' | 'Disabled' | 'No Data' {
  if (row.status === 'ERROR') return 'Critical'
  if (row.status === 'DEGRADED') return 'Warning'
  if (row.status === 'STOPPED') return 'Stopped'
  if (row.enabled === false) return 'Disabled'
  if (row.status === 'IDLE' || !row.hasRuntimeApiSnapshot) return 'No Data'
  if (row.status === 'RUNNING' || row.status === 'UNKNOWN') return 'Healthy'
  return 'Healthy'
}

export function aggregateGroupIssueCauses(
  rows: readonly StreamConsoleRow[],
  metricsWindow: StreamsMetricsWindow,
): { causes: string[]; label: string; streamCount: number; hiddenCount: number } {
  const causeSet = new Set<string>()
  let streamCount = 0
  for (const row of rows) {
    const rowCauses = deriveStreamIssueCauses(row, metricsWindow)
    if (rowCauses.length === 0) continue
    streamCount += 1
    for (const cause of rowCauses) causeSet.add(cause)
  }
  const causes = sortIssueCausesByPriority([...causeSet])
  const label = formatIssuesDisplay(causes)
  const hiddenCount = Math.max(0, causes.length - 2)
  return { causes, label, streamCount, hiddenCount }
}

export function formatStreamIssuesCell(
  row: StreamConsoleRow,
  metricsWindow: StreamsMetricsWindow,
): string {
  return formatIssuesDisplay(deriveStreamIssueCauses(row, metricsWindow))
}

export function streamSeverityFromCauses(
  row: StreamConsoleRow,
  metricsWindow: StreamsMetricsWindow,
): StreamOperationalSeverity {
  if (row.status === 'STOPPED') return 'stopped'
  if (row.enabled === false) return 'stopped'
  if (row.status === 'IDLE') return 'stopped'
  const causes = deriveStreamIssueCauses(row, metricsWindow)
  if (causes.some((c) => c === 'Protection Block' || c === 'Destination Error' || c === 'Checkpoint Error')) {
    if (row.status === 'ERROR' || row.routesError > 0) return 'critical'
  }
  if (causes.length > 0) {
    const base = effectiveStreamSeverity(normalizeSeverityInput(row))
    if (base === 'critical') return 'critical'
    return 'warning'
  }
  return effectiveStreamSeverity(normalizeSeverityInput(row))
}
