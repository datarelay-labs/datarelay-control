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

export function RouteDetailHealthPanel({
  routeId,
  streamId,
}: {
  routeId: number
  streamId: number | null
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
        const [h, f, r, dispositions] = await Promise.all([
          fetchRouteHealthDetail(routeId, { window: DEFAULT_WINDOW }),
          fetchRouteFailuresForRoute(routeId, { window: DEFAULT_WINDOW }),
          fetchRetriesSummary({ route_id: routeId, window: DEFAULT_WINDOW }),
          Promise.all([
            searchRuntimeDeliveryLogs({ route_id: routeId, stage: 'policy_blocked', window: DEFAULT_WINDOW, limit: 1 }),
            searchRuntimeDeliveryLogs({ route_id: routeId, stage: 'policy_review_required', window: DEFAULT_WINDOW, limit: 1 }),
            searchRuntimeDeliveryLogs({ route_id: routeId, stage: 'policy_quarantine', window: DEFAULT_WINDOW, limit: 1 }),
          ]),
        ])
        if (cancelled) return
        setDetail(h)
        setScopedFailures(f)
        setRetries(r)
        const latestPolicy = dispositions.flatMap((response) => response?.logs ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
        setPolicyDisposition(latestPolicy ? { stage: latestPolicy.stage, message: latestPolicy.message, createdAt: latestPolicy.created_at } : null)
        if (h == null && f == null) {
          setError('Health API unavailable for this route.')
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
  }, [routeId])

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
          <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Route health summary</h3>
          <span className="rounded-md border border-slate-200/90 bg-white px-2 py-0.5 font-mono text-[10px] font-medium text-slate-600 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            #{routeId}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
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

      {error ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
          {error}
        </div>
      ) : null}

      {loading && !detail?.score ? (
        <div className="h-28 animate-pulse rounded-xl bg-slate-200/80 dark:bg-gdc-elevated" data-testid="route-health-loading" />
      ) : null}

      {!loading && detail == null ? (
        <p className="text-[12px] text-slate-600 dark:text-gdc-muted" data-testid="route-health-empty">
          No health score in this window (no committed route delivery outcomes).
        </p>
      ) : detail?.score ? (
        <HealthScoreCard score={detail.score} dense />
      ) : null}

      {policyDisposition ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100" data-testid="route-policy-disposition-signal">
          <span className="font-semibold">Recent policy disposition:</span> {policyDisposition.stage.replaceAll('_', ' ')}
          <span className="text-amber-700/80 dark:text-amber-200/70"> · {policyDisposition.createdAt.slice(0, 19).replace('T', ' ')}</span>
          <span className="mt-0.5 block text-[10px]">{policyDisposition.message}</span>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200/80 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
          <h4 className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Delivery latency</h4>
          <p className="mt-1 text-[12px] tabular-nums text-slate-800 dark:text-slate-200">
            p95 {scopedFailures?.latency_ms_p95 != null ? `${Math.round(scopedFailures.latency_ms_p95)} ms` : '—'}
            <span className="text-slate-400"> · </span>
            avg {scopedFailures?.latency_ms_avg != null ? `${Math.round(scopedFailures.latency_ms_avg)} ms` : '—'}
          </p>
          <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-slate-500">Last successful delivery</p>
          <p className="font-mono text-[11px] text-slate-800 dark:text-slate-200">
            {scopedFailures?.last_success_at ? String(scopedFailures.last_success_at).slice(0, 19).replace('T', ' ') : '—'}
          </p>
          <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-slate-500">Last failed delivery</p>
          <p className="font-mono text-[11px] text-slate-800 dark:text-slate-200">
            {scopedFailures?.last_failure_at ? String(scopedFailures.last_failure_at).slice(0, 19).replace('T', ' ') : '—'}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200/80 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
          <h4 className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Retry · failure trend</h4>
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
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Failure trend</p>
              <HealthTrendMiniChart values={failureTrendValues} strokeClassName="text-rose-500 dark:text-rose-400" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
