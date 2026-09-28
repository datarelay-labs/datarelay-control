import type { EventsBreakdownSlice, EventsOverTimeBucket, RunHistoryRow } from '../components/streams/stream-runtime-detail-model'
import type { StreamRuntimeMetricsResponse } from './types/gdcApi'
import { getDisplayTimezoneCache } from '../lib/display-timezone-cache'
import { formatTimestampWithResolvedTimezone, parseApiTimestampMs, resolveDisplayTimezone } from '../lib/platform-timestamps'

function safeNonNegInt(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return Math.floor(x)
}

/** Format ISO timestamp for compact chart axis labels in the resolved display timezone. */
export function formatMetricsBucketLabel(iso: string): string {
  const t = parseApiTimestampMs(iso)
  if (t == null) return iso.trim().slice(11, 16)
  const tz = resolveDisplayTimezone(getDisplayTimezoneCache())
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(t))
  } catch {
    return iso.trim().slice(11, 16)
  }
}

export function formatIsoShort(iso: string | null | undefined): string {
  return formatTimestampWithResolvedTimezone(iso)
}

export function chartBucketsFromMetrics(metrics: StreamRuntimeMetricsResponse | null): EventsOverTimeBucket[] {
  if (!metrics?.events_over_time?.length) return []
  return metrics.events_over_time.map((b) => ({
    bucket: formatMetricsBucketLabel(b.timestamp),
    ingested: safeNonNegInt(b.events),
    mapped: 0,
    delivered: safeNonNegInt(b.delivered),
    failed: safeNonNegInt(b.failed),
  }))
}

export function breakdownSlicesFromMetrics(metrics: StreamRuntimeMetricsResponse | null): EventsBreakdownSlice[] {
  if (!metrics?.kpis) return []
  const delivered = safeNonNegInt(metrics.kpis.delivered_last_hour)
  const failed = safeNonNegInt(metrics.kpis.failed_last_hour)
  const events = safeNonNegInt(metrics.kpis.events_last_hour)
  const other = Math.max(0, events - delivered - failed)
  const slices: EventsBreakdownSlice[] = [
    { key: 'del', label: 'Delivered (1h)', value: delivered, color: '#22c55e' },
    { key: 'fail', label: 'Failed (1h)', value: failed, color: '#ef4444' },
  ]
  if (other > 0) {
    slices.push({ key: 'oth', label: 'Other / in-flight', value: other, color: '#8EC5FF' })
  }
  return slices
}

function mapRunStatus(s: string): RunHistoryRow['status'] {
  const u = s.toUpperCase()
  if (u === 'FAILED') return 'Failed'
  if (u === 'PARTIAL' || u === 'NO_EVENTS') return 'Partial'
  return 'Success'
}

export function runHistoryFromMetricsRecentRuns(metrics: StreamRuntimeMetricsResponse | null): RunHistoryRow[] {
  const runs = metrics?.recent_runs
  if (!runs?.length) return []
  return runs.map((r) => {
    const ms = safeNonNegInt(r.duration_ms)
    return {
      runId: r.run_id,
      startedAt: formatIsoShort(r.started_at),
      duration: ms > 0 ? `${ms} ms` : '—',
      status: mapRunStatus(r.status),
      events: safeNonNegInt(r.events),
      delivered: safeNonNegInt(r.delivered),
      failed: safeNonNegInt(r.failed),
    }
  })
}

export function eventsSparklineFromMetrics(metrics: StreamRuntimeMetricsResponse | null): number[] {
  const series = metrics?.events_over_time
  if (!series?.length) return [0, 0, 0, 0, 0, 0, 0]
  const tail = series.slice(-7)
  return tail.map((b) => safeNonNegInt(b.events))
}
