import type { LogExplorerRow } from './logs-types'

/** Never turn manually pasted URL identities into false-empty delivery evidence. */
export function safeOperationalResourceId(raw: string | null | undefined): number | undefined {
  if (raw == null || !/^\d+$/.test(raw)) return undefined
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export type HistogramBucket = { bucket: string; error: number; warn: number; info: number }

export function metricsWindowFromTimeRangeLabel(label: string): '15m' | '1h' | '6h' | '24h' {
  const s = label.toLowerCase()
  if (s.includes('15')) return '15m'
  if (s.includes('24')) return '24h'
  if (s.includes('6')) return '6h'
  return '1h'
}

export function formatLatencyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.round(ms)} ms`
}

export function safeCtxInt(ctx: Record<string, unknown>, key: string): number | null {
  const v = ctx[key]
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  return null
}

/** Route column label → destination name (right side of arrow). */
export function destinationFromRouteLabel(routeLabel: string): string {
  const parts = routeLabel.split('→')
  if (parts.length >= 2) return parts[parts.length - 1]?.trim() ?? '—'
  return '—'
}

export type DeliveryStatusTone = 'success' | 'warning' | 'danger' | 'muted'

export function deliveryStatusPresentation(raw: string | null | undefined): { label: string; tone: DeliveryStatusTone } {
  const s = (raw ?? '').toLowerCase().trim()
  if (!s) return { label: '—', tone: 'muted' }
  if (s.includes('success') || s === 'ok' || s === 'completed') return { label: 'SUCCESS', tone: 'success' }
  if (s.includes('throttle') || s.includes('rate')) return { label: 'THROTTLED', tone: 'warning' }
  if (s.includes('retry')) return { label: 'RETRY', tone: 'warning' }
  if (s.includes('fail') || s.includes('error')) return { label: 'FAILED', tone: 'danger' }
  return { label: raw.replace(/\s+/g, ' ').slice(0, 28).toUpperCase(), tone: 'muted' }
}

/** Uppercase stage chip for dense table (matches delivery_logs.stage). */
export function stageChipText(row: LogExplorerRow): string {
  const raw = String(row.contextJson.stage ?? row.pipelineStage ?? '').trim()
  if (!raw) return '—'
  return raw.replace(/\./g, '_').toUpperCase()
}

const DELIVERY_FAILURE_STAGES = new Set(['route_send_failed', 'route_retry_failed', 'route_unknown_failure_policy'])
const DELIVERY_SUCCESS_STAGES = new Set(['route_send_success', 'route_retry_success'])
const RETRY_OUTCOME_STAGES = new Set(['route_retry_success', 'route_retry_failed'])

/** Count delivery outcome rows vs lifecycle telemetry in the loaded log page. */
export function deliveryOutcomeCountsFromRows(
  rows: ReadonlyArray<{ level: string; contextJson: Record<string, unknown> }>,
): {
  deliveryFailed: number
  deliverySuccess: number
  retryOutcomes: number
  lifecycleInfo: number
} {
  let deliveryFailed = 0
  let deliverySuccess = 0
  let retryOutcomes = 0
  let lifecycleInfo = 0
  for (const row of rows) {
    const stage = typeof row.contextJson.stage === 'string' ? row.contextJson.stage : ''
    if (DELIVERY_FAILURE_STAGES.has(stage)) deliveryFailed += 1
    else if (DELIVERY_SUCCESS_STAGES.has(stage)) deliverySuccess += 1
    else if (RETRY_OUTCOME_STAGES.has(stage)) retryOutcomes += 1
    else if (row.level === 'INFO') lifecycleInfo += 1
  }
  return { deliveryFailed, deliverySuccess, retryOutcomes, lifecycleInfo }
}

export function kpiPercent(part: number, total: number): string {
  if (total <= 0) return '0%'
  return `${((100 * part) / total).toFixed(2)}% of total`
}

/** Bucket logs into histogram bars for Recharts (best-effort). */
export function bucketLogsForHistogram(rows: readonly LogExplorerRow[], maxBuckets = 12): HistogramBucket[] {
  if (rows.length === 0) return []
  const times = rows.map((r) => new Date(r.timeIso).getTime()).filter((t) => Number.isFinite(t))
  if (times.length === 0) return []
  const minT = Math.min(...times)
  const maxT = Math.max(...times)
  const span = Math.max(maxT - minT, 1)
  const n = Math.min(maxBuckets, Math.max(6, Math.ceil(rows.length / 8)))
  const buckets: HistogramBucket[] = Array.from({ length: n }, (_, i) => ({
    bucket: `${i}`,
    error: 0,
    warn: 0,
    info: 0,
  }))
  for (const row of rows) {
    const t = new Date(row.timeIso).getTime()
    if (!Number.isFinite(t)) continue
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((t - minT) / span) * n)))
    if (row.level === 'ERROR') buckets[idx].error += 1
    else if (row.level === 'WARN') buckets[idx].warn += 1
    else buckets[idx].info += 1
  }
  return buckets
}

export type TraceStepKey = 'FETCH' | 'MAPPING' | 'ENRICHMENT' | 'ROUTE' | 'DELIVERY' | 'CHECKPOINT'

export type TraceStepState = 'complete' | 'failed' | 'pending'

/** Operational pipeline trace for the Trace tab (conceptual stages). */
export function buildOperationalTrace(row: LogExplorerRow): { key: TraceStepKey; state: TraceStepState }[] {
  const stage = String(row.contextJson.stage ?? '').toLowerCase()
  const fail = row.level === 'ERROR'

  const order: TraceStepKey[] = ['FETCH', 'MAPPING', 'ENRICHMENT', 'ROUTE', 'DELIVERY', 'CHECKPOINT']

  let failIdx: number | null = null
  if (fail) {
    if (stage.includes('fetch') || stage === 'source_fetch' || stage.includes('source_rate')) failIdx = 0
    else if (stage === 'parse' || stage === 'mapping') failIdx = 1
    else if (stage === 'enrichment') failIdx = 2
    else if (stage === 'format' || stage === 'route') failIdx = 3
    else if (
      stage.includes('send') ||
      stage.includes('webhook') ||
      stage.includes('syslog') ||
      stage.includes('retry') ||
      stage.includes('rate')
    )
      failIdx = 4
    else if (stage.includes('checkpoint')) failIdx = 5
    else failIdx = 4
  }

  const completeThrough = fail
    ? -1
    : stage === 'run_complete' || stage === 'checkpoint_update'
      ? 5
      : stage.includes('checkpoint')
        ? 5
        : stage.includes('send') || stage.includes('webhook') || stage.includes('syslog')
          ? 4
          : stage === 'format' || stage === 'route'
            ? 3
            : stage === 'enrichment'
              ? 2
              : stage === 'mapping' || stage === 'parse'
                ? 1
                : stage.includes('fetch') || stage === 'source_fetch'
                  ? 0
                  : 4

  return order.map((key, i) => {
    if (failIdx !== null) {
      if (i < failIdx!) return { key, state: 'complete' as const }
      if (i === failIdx!) return { key, state: 'failed' as const }
      return { key, state: 'pending' as const }
    }
    if (i <= completeThrough) return { key, state: 'complete' as const }
    return { key, state: 'pending' as const }
  })
}

export type RetryTimelineEntry = { attempt: number; atLabel: string; backoffLabel: string; outcome: string }

/** Synthetic retry timeline when structured retry steps are not persisted (Phase 1 UX). */
export function buildRetryTimelineEntries(row: LogExplorerRow): RetryTimelineEntry[] {
  const n = safeCtxInt(row.contextJson, 'retry_count') ?? 0
  if (n <= 0) return []
  const base = new Date(row.timeIso).getTime()
  const out: RetryTimelineEntry[] = []
  for (let a = 1; a <= n; a += 1) {
    const backoffMs = Math.min(1500 * 2 ** (a - 1), 120_000)
    const t = base - (n - a) * backoffMs
    const d = new Date(t)
    const atLabel = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 23).replace('T', ' ') : '—'
    const outcome = a === n ? (row.level === 'ERROR' ? 'failed' : 'last attempt') : 'retry scheduled'
    out.push({
      attempt: a,
      atLabel,
      backoffLabel: `${backoffMs} ms`,
      outcome,
    })
  }
  return out
}
