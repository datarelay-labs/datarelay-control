import { Activity, ExternalLink, LineChart as LineChartIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchRouteFailuresForRoute, fetchRetriesSummary, type AnalyticsWindowToken } from '../../api/gdcRuntimeAnalytics'
import { fetchRouteHealthDetail } from '../../api/gdcRuntimeHealth'
import { searchRuntimeDeliveryLogs } from '../../api/gdcRuntime'
import type { RouteFailuresScopedResponse, RouteHealthDetailResponse } from '../../api/types/gdcApi'
import { logsExplorerPath, runtimeAnalyticsPath, streamRuntimePath } from '../../config/nav-paths'
import { FailureRateIndicator } from '../runtime/operational-health/failure-rate-indicator'
import { HealthScoreCard } from '../runtime/operational-health/health-score-card'
import { HealthTrendMiniChart } from '../runtime/operational-health/health-trend-mini-chart'
import { RetryPressureIndicator } from '../runtime/operational-health/retry-pressure-indicator'

const DEFAULT_WINDOW: AnalyticsWindowToken = '24h'

type RouteHealthPanelProps = { routeId: number; streamId: number | null }

/** A new selection must never display the previous Route's evidence, even for one render. */
export function RouteDetailHealthPanel({ routeId, streamId }: RouteHealthPanelProps) {
  if (!Number.isSafeInteger(routeId) || routeId <= 0 || (streamId != null && (!Number.isSafeInteger(streamId) || streamId <= 0))) {
    return <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">Select a valid Route and Stream to inspect operational evidence.</p>
  }
  return <RouteHealthEvidence key={`${routeId}:${streamId ?? 'unknown'}`} routeId={routeId} streamId={streamId} />
}

function timestamp(value: string | null | undefined): string {
  return value && value.includes('T') && Number.isFinite(Date.parse(value)) ? value : 'Unknown'
}

function RouteHealthEvidence({ routeId, streamId }: RouteHealthPanelProps) {
  const [loading, setLoading] = useState(true)
  const [displayedAt, setDisplayedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [evidenceWarnings, setEvidenceWarnings] = useState<string[]>([])
  const [detail, setDetail] = useState<RouteHealthDetailResponse | null>(null)
  const [scopedFailures, setScopedFailures] = useState<RouteFailuresScopedResponse | null>(null)
  const [retries, setRetries] = useState<Awaited<ReturnType<typeof fetchRetriesSummary>>>(null)
  const [policyDisposition, setPolicyDisposition] = useState<{ stage: string; message: string; createdAt: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [healthResult, failuresResult, retriesResult, blockedResult, reviewResult, quarantineResult] = await Promise.allSettled([
          fetchRouteHealthDetail(routeId, { window: DEFAULT_WINDOW }),
          fetchRouteFailuresForRoute(routeId, { window: DEFAULT_WINDOW }),
          fetchRetriesSummary({ route_id: routeId, window: DEFAULT_WINDOW }),
          searchRuntimeDeliveryLogs({ route_id: routeId, stage: 'policy_blocked', window: DEFAULT_WINDOW, limit: 1 }),
          searchRuntimeDeliveryLogs({ route_id: routeId, stage: 'policy_review_required', window: DEFAULT_WINDOW, limit: 1 }),
          searchRuntimeDeliveryLogs({ route_id: routeId, stage: 'policy_quarantine', window: DEFAULT_WINDOW, limit: 1 }),
        ] as const)
        if (cancelled) return
        const h = healthResult.status === 'fulfilled' ? healthResult.value : null
        const f = failuresResult.status === 'fulfilled' ? failuresResult.value : null
        const r = retriesResult.status === 'fulfilled' ? retriesResult.value : null
        const policyResults = [blockedResult, reviewResult, quarantineResult]
        const dispositions = policyResults.flatMap((result) => result.status === 'fulfilled' && result.value != null ? [result.value] : [])
        if (
          (h != null && (h.route_id !== routeId || (streamId != null && h.stream_id !== streamId)))
          || (f != null && (f.route_id !== routeId || (f.filters?.route_id != null && f.filters.route_id !== routeId)))
          || (f?.filters?.stream_id != null && streamId != null && f.filters.stream_id !== streamId)
          || (r != null && r.filters?.route_id !== routeId)
          || (r?.filters?.stream_id != null && streamId != null && r.filters.stream_id !== streamId)
        ) {
          setError('Route identity did not match the selected path. No mismatched evidence is displayed.')
          return
        }
        setDisplayedAt(Date.now())
        setDetail(h)
        setScopedFailures(f)
        setRetries(r)
        const warnings: string[] = []
        if (h == null) warnings.push('Health score unavailable.')
        if (f == null) warnings.push('Delivery metrics unavailable.')
        if (r == null) warnings.push('Retry summary unavailable.')
        if (dispositions.length !== 3) warnings.push('Some policy evidence is unavailable; absence of results does not prove absence of policy outcomes.')
        const allPolicy = dispositions.flatMap((response) => response.logs ?? [])
        const matchingPolicy = allPolicy.filter((entry) => entry.route_id === routeId && (streamId == null || entry.stream_id === streamId))
        if (matchingPolicy.length !== allPolicy.length) warnings.push('Policy evidence for another path was excluded.')
        const latestPolicy = matchingPolicy.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0]
        setPolicyDisposition(latestPolicy ? { stage: latestPolicy.stage, message: latestPolicy.message, createdAt: latestPolicy.created_at } : null)
        setEvidenceWarnings(warnings)
        if (h == null && f == null) {
          setError('Route health is unavailable. A failed read is not a healthy or empty result.')
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [routeId, streamId])

  const observationWindow = detail?.time ?? scopedFailures?.time
  const generatedAt = timestamp(observationWindow?.generated_at)
  const snapshotTime = generatedAt !== 'Unknown' ? generatedAt : timestamp(observationWindow?.snapshot_id)
  const snapshotAgeMs = snapshotTime === 'Unknown' || displayedAt == null ? null : displayedAt - Date.parse(snapshotTime)
  const successCount = detail?.score?.metrics?.success_count
  const failureCount = detail?.score?.metrics?.failure_count
  const scoreCountsKnown = typeof successCount === 'number' && Number.isFinite(successCount) && successCount >= 0
    && typeof failureCount === 'number' && Number.isFinite(failureCount) && failureCount >= 0
  const hasScoreEvidence = detail?.score != null && scoreCountsKnown && successCount + failureCount > 0

  const failureTrendValues = useMemo(
    () => (scopedFailures?.failure_trend ?? []).map((b) => b.failure_count),
    [scopedFailures],
  )

  const logsHref = useMemo(() => logsExplorerPath({ route_id: routeId, stream_id: streamId ?? undefined }), [routeId, streamId])
  const analyticsHref = useMemo(
    () => runtimeAnalyticsPath({ window: DEFAULT_WINDOW, route_id: routeId, stream_id: streamId ?? undefined }),
    [routeId, streamId],
  )

  return (
    <section
      aria-label="Route operational health"
      className="space-y-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="route-detail-health-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Route health summary</h3>
          <span className="rounded-md border border-slate-200/90 bg-white px-2 py-0.5 font-mono text-xs font-medium text-slate-600 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            #{routeId}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 text-sm font-semibold">
          <Link
            to={logsHref}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-violet-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-200 dark:hover:bg-gdc-rowHover"
          >
            Logs
            <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
          <Link
            to={analyticsHref}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-violet-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-200 dark:hover:bg-gdc-rowHover"
          >
            <LineChartIcon className="h-3.5 w-3.5" aria-hidden />
            Analytics
          </Link>
          {streamId != null ? (
            <Link
              to={streamRuntimePath(String(streamId))}
              className="inline-flex items-center rounded-md px-2 py-1 text-violet-700 hover:underline dark:text-violet-300"
            >
              Stream runtime
            </Link>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-slate-600 dark:text-gdc-muted">Gateway delivery outcomes, not receiver ingestion confirmation. Source collection volume is reported separately; fan-out is not additional input.</p>
      {observationWindow ? <div aria-label="Route observation window" className="space-y-1 text-xs text-slate-500 dark:text-gdc-muted">
        <p>Requested window ({DEFAULT_WINDOW}): <time>{timestamp(observationWindow.since)}</time> — <time>{timestamp(observationWindow.until)}</time></p>
        <p>{snapshotTime === 'Unknown'
          ? 'Snapshot time unavailable; the query window does not establish freshness.'
          : `Snapshot ${snapshotTime}${snapshotAgeMs != null && snapshotAgeMs >= 0 ? ` · ${Math.floor(snapshotAgeMs / 60000)} minute(s) old at display` : ' · observation age unavailable'}`}</p>
      </div> : null}
      {evidenceWarnings.length > 0 && !error ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{evidenceWarnings.join(' ')}</p> : null}
      {error ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="h-28 animate-pulse rounded-xl bg-slate-200/80 dark:bg-gdc-elevated" data-testid="route-health-loading" />
      ) : null}

      {!loading && !error && !hasScoreEvidence ? (
        <p className="text-sm text-slate-600 dark:text-gdc-muted" data-testid="route-health-empty">
          {scoreCountsKnown ? 'No committed Route delivery outcomes in the returned score; health is not established.' : 'Health score evidence is unavailable; missing outcome counts are not zero.'}
        </p>
      ) : !loading && !error && hasScoreEvidence && detail?.score ? (
        <HealthScoreCard score={detail.score} dense />
      ) : null}

      {policyDisposition ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100" data-testid="route-policy-disposition-signal">
          <span className="font-semibold">{timestamp(policyDisposition.createdAt) === 'Unknown' ? 'Policy outcome (time unknown):' : 'Recent policy disposition:'}</span> {policyDisposition.stage.replaceAll('_', ' ')}
          <span className="text-amber-700/80 dark:text-amber-200/70"> · {timestamp(policyDisposition.createdAt)}</span>
          <span className="mt-0.5 block text-xs">{policyDisposition.message}</span>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200/80 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Delivery latency</h4>
          <p className="mt-1 text-sm tabular-nums text-slate-800 dark:text-slate-200">
            p95 {scopedFailures?.latency_ms_p95 != null ? `${Math.round(scopedFailures.latency_ms_p95)} ms` : '—'}
            <span className="text-slate-400"> · </span>
            avg {scopedFailures?.latency_ms_avg != null ? `${Math.round(scopedFailures.latency_ms_avg)} ms` : '—'}
          </p>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">Last successful delivery</p>
          <p className="font-mono text-sm text-slate-800 dark:text-slate-200">
            {timestamp(scopedFailures?.last_success_at)}
          </p>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">Last failed delivery</p>
          <p className="font-mono text-sm text-slate-800 dark:text-slate-200">
            {timestamp(scopedFailures?.last_failure_at)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200/80 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Retry · failure trend</h4>
          <div className="mt-2 flex flex-wrap items-start gap-4">
            <div>
              <RetryPressureIndicator
                retryEventCount={retries?.total_retry_outcome_events ?? detail?.score?.metrics?.retry_event_count}
                retryRate={detail?.score?.metrics?.retry_rate}
              />
              <FailureRateIndicator
                className="mt-3"
                rate={
                  scopedFailures?.totals
                    ? scopedFailures.totals.failure_events + scopedFailures.totals.success_events > 0
                      ? scopedFailures.totals.failure_events /
                        (scopedFailures.totals.failure_events + scopedFailures.totals.success_events)
                      : null
                    : detail?.score?.metrics?.failure_rate
                }
              />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Failure trend</p>
              <HealthTrendMiniChart values={failureTrendValues} strokeClassName="text-rose-500 dark:text-rose-400" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
