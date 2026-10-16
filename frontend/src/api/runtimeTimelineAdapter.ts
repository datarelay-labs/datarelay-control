import type { RecentLogLine, RunHistoryRow } from '../components/streams/stream-runtime-detail-model'
import { toOperatorEventLabel } from '../lib/stream-governance-snapshot'
import type { RuntimeTimelineItem } from './types/gdcApi'
import { formatTimestampWithResolvedTimezone, getTimezoneAbbreviation, parseApiTimestampMs, resolveDisplayTimezone } from '../lib/platform-timestamps'
import { getDisplayTimezoneCache } from '../lib/display-timezone-cache'

function safeNonNegInt(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return Math.floor(x)
}

function normalizeRecentLevel(raw: string | null | undefined): RecentLogLine['level'] {
  const u = String(raw ?? '').trim().toUpperCase()
  if (u === 'ERROR') return 'ERROR'
  if (u === 'WARN' || u === 'WARNING') return 'WARN'
  if (u === 'DEBUG') return 'DEBUG'
  return 'INFO'
}

function formatTimelineTimestamp(iso: string | null | undefined): string {
  return formatTimestampWithResolvedTimezone(iso)
}

function formatClockTime(iso: string | null | undefined): string {
  if (iso == null || typeof iso !== 'string') return '—'
  const t = parseApiTimestampMs(iso)
  if (t == null) return '—'
  const tz = resolveDisplayTimezone(getDisplayTimezoneCache())
  try {
    const at = new Date(t)
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(at)
    return `${clock} ${getTimezoneAbbreviation(tz, at)}`
  } catch {
    return '—'
  }
}

function formatLatencyMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const n = typeof ms === 'number' ? ms : Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  return `${safeNonNegInt(n)} ms`
}

/**
 * Timeline fallback for Run History. A pipeline event is not a Run.
 * Only a nonblank authoritative run_id on a lifecycle event can identify a run.
 * A timeline cannot establish processed/delivered event counts, so those stay unverified.
 */
export function timelineItemsToRunHistoryRows(items: readonly RuntimeTimelineItem[] | null | undefined): RunHistoryRow[] {
  if (!items?.length) return []

  type RunEvidence = { runId: string; started: RuntimeTimelineItem | null; terminal: RuntimeTimelineItem | null }
  const byRun = new Map<string, RunEvidence>()

  for (const item of items) {
    const runId = typeof item.run_id === 'string' ? item.run_id.trim() : ''
    const stage = String(item.stage ?? '').trim().toLowerCase()
    if (!runId || (stage !== 'run_started' && stage !== 'run_complete' && stage !== 'run_failed')) continue

    let evidence = byRun.get(runId)
    if (!evidence) {
      evidence = { runId, started: null, terminal: null }
      byRun.set(runId, evidence)
    }
    if (stage === 'run_started' && evidence.started === null) evidence.started = item
    if (stage === 'run_complete' || stage === 'run_failed') evidence.terminal = item
  }

  // The timeline source is ascending; show most recently observed runs first.
  return [...byRun.values()].reverse().map(({ runId, started, terminal }): RunHistoryRow => ({
    runId,
    startedAt: started ? formatTimelineTimestamp(started.created_at) : '—',
    duration: '—',
    status: terminal?.stage?.toLowerCase() === 'run_failed'
      ? 'Failed'
      : terminal?.stage?.toLowerCase() === 'run_complete'
        ? 'Completed'
        : 'Started',
    events: 0,
    delivered: 0,
    failed: 0,
    countsVerified: false,
  }))
}

/** Sidebar recent log lines derived from the ASC timeline payload, newest first. */
export function timelineItemsToRecentLogLines(items: readonly RuntimeTimelineItem[] | null | undefined, max = 12): RecentLogLine[] {
  if (!items?.length) return []
  const slice = items.slice(-max).reverse()
  return slice.map((t) => {
    const raw = String(t.message ?? '')
    const operatorMsg = toOperatorEventLabel(raw, t.stage)
    return {
      at: formatClockTime(t.created_at),
      level: normalizeRecentLevel(t.level),
      message: operatorMsg,
      rawMessage: raw.length > 140 ? `${raw.slice(0, 137)}…` : raw,
      errorCode: t.error_code,
      stage: t.stage,
      runId: t.run_id,
      routeId: t.route_id,
      destinationId: t.destination_id,
      duration: formatLatencyMs(t.latency_ms),
    }
  })
}
