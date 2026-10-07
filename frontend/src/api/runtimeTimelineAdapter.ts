import type { RecentLogLine, RunHistoryRow } from '../components/streams/stream-runtime-detail-model'
import { toOperatorEventLabel } from '../lib/stream-governance-snapshot'
import type { RuntimeTimelineItem } from './types/gdcApi'
import { formatTimestampWithResolvedTimezone, parseApiTimestampMs, resolveDisplayTimezone } from '../lib/platform-timestamps'
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
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(t))
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

/** Maps timeline delivery rows into the Run History table shape (one row per timeline event). */
export function timelineItemsToRunHistoryRows(items: readonly RuntimeTimelineItem[] | null | undefined): RunHistoryRow[] {
  if (!items?.length) return []
  return items.map((t) => {
    const level = String(t.level ?? '').toUpperCase()
    const st = String(t.status ?? '').toLowerCase()
    let status: RunHistoryRow['status'] = 'Success'
    if (level === 'ERROR' || st.includes('fail') || st === 'error') status = 'Failed'
    else if (level === 'WARN' || st.includes('partial')) status = 'Partial'

    const failed = status === 'Failed' ? 1 : 0
    const delivered = status === 'Success' ? 1 : 0

    const idPart = t.id != null && Number.isFinite(Number(t.id)) ? String(t.id) : '—'

    return {
      runId: `evt-${idPart}`,
      startedAt: formatTimelineTimestamp(t.created_at),
      duration: formatLatencyMs(t.latency_ms),
      status,
      events: 1,
      delivered,
      failed,
    }
  })
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
      duration: formatLatencyMs(t.latency_ms),
    }
  })
}
