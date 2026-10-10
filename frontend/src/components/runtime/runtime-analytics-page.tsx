import { Activity, ExternalLink, LineChart as LineChartIcon, RefreshCw, Route as RouteIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  fetchRetriesSummary,
  fetchRouteFailuresAnalytics,
  fetchStreamRetriesAnalytics,
  type AnalyticsWindowToken,
} from '../../api/gdcRuntimeAnalytics'
import { fetchObservabilitySummary } from '../../api/observabilitySummary'
import { allSnapshotsMatch, createRuntimeSnapshotId } from '../../api/runtimeSnapshotSync'
import { metricDescription, metricSnapshotLabel } from '../../api/metricMeta'
import { visualizationSummary } from '../../api/visualizationMeta'
import type {
  ObservabilitySummaryResponse,
  RouteFailuresAnalyticsResponse,
  RetrySummaryResponse,
  StreamRetriesAnalyticsResponse,
} from '../../api/types/gdcApi'
import { logsExplorerPath, runtimeOverviewPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { useVisibilityGate } from '../../hooks/use-visibility-gate'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { RuntimeHealthSection } from './runtime-health-section'

const WINDOW_OPTIONS: readonly AnalyticsWindowToken[] = ['15m', '1h', '6h', '24h']

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function parseOptionalInt(raw: string | null): number | undefined {
  if (raw == null || !/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'amber' | 'rose'
}) {
  const toneCls =
    tone === 'amber'
      ? 'border-amber-500/25 bg-amber-500/[0.06]'
      : tone === 'rose'
        ? 'border-rose-500/25 bg-rose-500/[0.06]'
        : 'border-slate-200/90 bg-white dark:border-gdc-border dark:bg-gdc-card'
  return (
    <div className={cn('rounded-xl border px-3 py-2.5 shadow-sm', toneCls)}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">{hint}</p> : null}
    </div>
  )
}

export function RuntimeAnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const windowRaw = searchParams.get('window') as AnalyticsWindowToken | null
  const windowToken = WINDOW_OPTIONS.includes(windowRaw as AnalyticsWindowToken) ? windowRaw! : '24h'
  const streamId = parseOptionalInt(searchParams.get('stream_id'))
  const routeId = parseOptionalInt(searchParams.get('route_id'))
  const destinationId = parseOptionalInt(searchParams.get('destination_id'))
  const invalidAnalyticsFilters = [
    { key: 'stream_id', label: 'Stream' },
    { key: 'route_id', label: 'Route' },
    { key: 'destination_id', label: 'Destination' },
  ].filter(({ key }) => {
    const raw = searchParams.get(key)
    return raw != null && raw !== '' && parseOptionalInt(raw) == null
  })

  const [failures, setFailures] = useState<RouteFailuresAnalyticsResponse | null>(null)
  const [observability, setObservability] = useState<ObservabilitySummaryResponse | null>(null)
  const [retries, setRetries] = useState<RetrySummaryResponse | null>(null)
  const [retryRank, setRetryRank] = useState<StreamRetriesAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snapshotId, setSnapshotId] = useState(() => createRuntimeSnapshotId())
  const loadGenerationRef = useRef(0)
  const healthVisibility = useVisibilityGate<HTMLDivElement>()

  const query = useMemo(
    () => ({
      window: WINDOW_OPTIONS.includes(windowToken as AnalyticsWindowToken) ? windowToken : '24h',
      stream_id: streamId,
      route_id: routeId,
      destination_id: destinationId,
    }),
    [windowToken, streamId, routeId, destinationId],
  )

  const load = useCallback(async () => {
    const token = ++loadGenerationRef.current
    const isCurrent = () => token === loadGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const requestedSnapshotId = createRuntimeSnapshotId()
      const canonicalSummary = await fetchObservabilitySummary(query.window, { snapshot_id: requestedSnapshotId })
      if (!isCurrent()) return
      if (canonicalSummary == null || !allSnapshotsMatch(requestedSnapshotId, [canonicalSummary])) {
        setError('Could not load the canonical observability summary.')
        return
      }
      const snapshot_id = canonicalSummary.snapshot_id
      const [f, r, rk] = await Promise.all([
        fetchRouteFailuresAnalytics({ ...query, snapshot_id }),
        fetchRetriesSummary({ ...query, snapshot_id }),
        fetchStreamRetriesAnalytics({ ...query, limit: 15, snapshot_id }),
      ])
      if (!isCurrent()) return
      if (f == null || r == null || rk == null) {
        setError('Could not load analytics (API unavailable or unauthorized).')
        return
      }
      if (!allSnapshotsMatch(snapshot_id, [canonicalSummary, f, r, rk])) return
      setSnapshotId(snapshot_id)
      setObservability(canonicalSummary)
      setFailures(f)
      setRetries(r)
      setRetryRank(rk)
    } catch (e) {
      if (!isCurrent()) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  const trendData = useMemo(() => {
    const rows = failures?.failure_trend ?? []
    return rows.map((b) => ({
      t: new Date(b.bucket_start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      failures: b.failure_count,
    }))
  }, [failures])
  const failureTrendSemantics = visualizationSummary(
    failures?.visualization_meta,
    'analytics.delivery_failures.bucket_histogram',
  )

  const emptyOperational =
    failures != null &&
    failures.totals.failure_events === 0 &&
    failures.totals.success_events === 0 &&
    (retries?.total_retry_outcome_events ?? 0) === 0

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-slate-50/95 pb-3 pt-1 backdrop-blur dark:border-gdc-border dark:bg-gdc-section">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <LineChartIcon className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
              <h1 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">Delivery analytics</h1>
              <span className="rounded-md border border-slate-200/90 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
                Delivery records
              </span>
            </div>
            <p className="max-w-2xl text-[12px] text-slate-600 dark:text-gdc-muted">
              Route failure and retry KPIs with drill-down to Logs. Default window: last 24 hours.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {routeId != null ? (
              <Link
                to={logsExplorerPath({ route_id: routeId, stream_id: streamId, destination_id: destinationId })}
                className="inline-flex min-h-9 items-center rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-800 hover:bg-violet-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-violet-900/40 dark:bg-violet-950/20 dark:text-violet-200"
              >
                Back to Route #{routeId} logs
              </Link>
            ) : null}
            <Link
              to={runtimeOverviewPath()}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            >
              Runtime
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
            Window
            <select
              value={windowToken}
              onChange={(e) => {
                const v = e.target.value as AnalyticsWindowToken
                const next = new URLSearchParams(searchParams)
                next.set('window', v)
                setSearchParams(next, { replace: true })
              }}
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-900 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
            stream_id
            <input
              type="text"
              inputMode="numeric"
              placeholder="Any"
              value={searchParams.get('stream_id') ?? ''}
              id="analytics-stream-id"
              className="h-8 w-[7rem] rounded-lg border border-slate-200 bg-white px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
              onChange={(e) => {
                const v = e.target.value.trim()
                const next = new URLSearchParams(searchParams)
                if (v === '') next.delete('stream_id')
                else if (parseOptionalInt(v) != null) next.set('stream_id', v)
                setSearchParams(next, { replace: true })
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
            route_id
            <input
              type="text"
              inputMode="numeric"
              placeholder="Any"
              value={searchParams.get('route_id') ?? ''}
              id="analytics-route-id"
              className="h-8 w-[7rem] rounded-lg border border-slate-200 bg-white px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
              onChange={(e) => {
                const v = e.target.value.trim()
                const next = new URLSearchParams(searchParams)
                if (v === '') next.delete('route_id')
                else if (parseOptionalInt(v) != null) next.set('route_id', v)
                setSearchParams(next, { replace: true })
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
            destination_id
            <input
              type="text"
              inputMode="numeric"
              placeholder="Any"
              value={searchParams.get('destination_id') ?? ''}
              id="analytics-destination-id"
              className="h-8 w-[7rem] rounded-lg border border-slate-200 bg-white px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
              onChange={(e) => {
                const v = e.target.value.trim()
                const next = new URLSearchParams(searchParams)
                if (v === '') next.delete('destination_id')
                else if (parseOptionalInt(v) != null) next.set('destination_id', v)
                setSearchParams(next, { replace: true })
              }}
            />
          </label>
        </div>
      </header>

      {invalidAnalyticsFilters.length > 0 ? (
        <div
          role="status"
          aria-label="Invalid analytics filters"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <span>
            {invalidAnalyticsFilters.map(({ label }) => `Invalid ${label} ID ignored`).join(' · ')}. Use positive, whole-number IDs; invalid values were not applied.
          </span>
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams)
              for (const { key } of invalidAnalyticsFilters) next.delete(key)
              setSearchParams(next, { replace: true })
            }}
            className="min-h-9 shrink-0 rounded-md border border-amber-400 px-3 py-1.5 text-xs font-semibold hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 dark:border-amber-700 dark:hover:bg-amber-950/50"
          >
            Clear invalid IDs
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-900 dark:border-rose-900/50 dark:text-rose-100">
          {error}
        </div>
      ) : null}

      {loading && !failures ? (
        <div className="flex items-center gap-2 text-[12px] text-slate-500">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
          Loading analytics…
        </div>
      ) : null}

      {loading && failures ? (
        <p className="sr-only" role="status">
          Refreshing analytics…
        </p>
      ) : null}

      {failures && retries && retryRank ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Failed delivery outcomes"
              value={String(observability?.totals.delivery_failed_events ?? failures.totals.failure_events)}
              hint={`${metricDescription(observability?.metric_meta ?? failures.metric_meta, 'delivery_outcomes.failure')} · Successful deliveries ${
                observability?.totals.delivery_success_events ?? failures.totals.success_events
              }`}
              tone="rose"
            />
            <KpiCard
              label="Delivery failure rate"
              value={formatPct(failures.totals.overall_failure_rate)}
              hint={`${metricDescription(failures.metric_meta, 'delivery_outcomes.window')} · ${metricSnapshotLabel(failures.metric_meta, 'delivery_outcomes.window', failures.time.window)}`}
              tone="amber"
            />
            <KpiCard
              label="p95 latency"
              value={failures.latency_ms_p95 != null ? `${Math.round(failures.latency_ms_p95)} ms` : '—'}
              hint={failures.latency_ms_avg != null ? `avg ${Math.round(failures.latency_ms_avg)} ms` : undefined}
            />
            <KpiCard
              label="Retry outcomes"
              value={String(
                observability != null
                  ? observability.totals.retry_success_events + observability.totals.retry_failed_events
                  : retries.total_retry_outcome_events,
              )}
              hint={`ok ${observability?.totals.retry_success_events ?? retries.retry_success_events} · failed ${
                observability?.totals.retry_failed_events ?? retries.retry_failed_events
              } · ${metricDescription(retries.metric_meta, 'delivery_outcomes.window')} · ${metricSnapshotLabel(retries.metric_meta, 'delivery_outcomes.window', retries.time.window)}`}
            />
          </div>

          <div ref={healthVisibility.ref}>
            <RuntimeHealthSection
              query={{ ...query, scoring_mode: 'historical_analytics', snapshot_id: snapshotId }}
              enabled={healthVisibility.hasBeenVisible}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
                <div>
                  <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Failure histogram</h2>
                  <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">{failureTrendSemantics}</p>
                </div>
                <span className="text-[10px] text-slate-500">{failures.time.window}</span>
              </div>
              <div className="h-[200px] p-2">
                {trendData.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center text-center text-[12px] text-slate-500">
                    {emptyOperational ? 'No delivery outcomes in this window.' : 'No failure samples in this window.'}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trendData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--gdc-chart-line)" />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--gdc-chart-muted)' }} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--gdc-chart-muted)' }} width={28} allowDecimals={false} />
                      <Tooltip
                        formatter={(value) => [`${value} failures`, 'Failures']}
                        labelFormatter={(label) => `Bucket ${label} · ${failureTrendSemantics}`}
                        contentStyle={{ fontSize: 11, borderRadius: 8 }}
                      />
                      <Bar dataKey="failures" fill="#f43f5e" name="Failures" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
                <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Top error codes</h2>
              </div>
              <ul className="max-h-[200px] divide-y divide-slate-100 overflow-auto dark:divide-slate-800">
                {(failures.top_error_codes ?? []).length === 0 ? (
                  <li className="px-3 py-6 text-center text-[12px] text-slate-500">No error_code values</li>
                ) : (
                  failures.top_error_codes.map((c) => (
                    <li key={`${c.error_code ?? 'null'}-${c.count}`} className="flex items-center justify-between px-3 py-2 text-[12px]">
                      <span className="font-mono text-slate-800 dark:text-slate-200">{c.error_code ?? '—'}</span>
                      <span className="tabular-nums text-slate-600 dark:text-gdc-muted">{c.count}</span>
                    </li>
                  ))
                )}
              </ul>
            </section>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
                <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Failure stages</h2>
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {(failures.top_failed_stages ?? []).map((s) => (
                  <li key={s.stage} className="flex items-center justify-between px-3 py-2 text-[12px]">
                    <span className="font-mono text-slate-800 dark:text-slate-200">{s.stage}</span>
                    <span className="tabular-nums text-slate-600">{s.count}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
                <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Retry KPIs</h2>
              </div>
              <dl className="grid grid-cols-2 gap-2 p-3 text-[12px]">
                <div>
                  <dt className="text-[10px] font-semibold uppercase text-slate-500">Logged retry units (sum)</dt>
                  <dd className="font-mono text-slate-900 dark:text-slate-50">{retries.retry_column_sum}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase text-slate-500">Window label</dt>
                  <dd className="font-mono text-slate-900 dark:text-slate-50">{retries.time.window}</dd>
                </div>
              </dl>
            </section>
          </div>

          <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                <RouteIcon className="h-4 w-4 text-slate-500" aria-hidden />
                Unstable routes
              </h2>
              <span className="text-[10px] text-slate-500">failure_rate ≥ 15% · n ≥ 5</span>
            </div>
            <div className="overflow-x-auto">
              <table className={opTable}>
                <thead>
                  <tr className={opThRow}>
                    <th className={opTh}>Route</th>
                    <th className={opTh}>Stream</th>
                    <th className={opTh}>Failure rate</th>
                    <th className={opTh}>Samples</th>
                    <th className={opTh}>Logs</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.unstable_routes.length === 0 ? (
                    <tr className={opTr}>
                      <td className={opTd} colSpan={5}>
                        No unstable routes detected.
                      </td>
                    </tr>
                  ) : (
                    failures.unstable_routes.map((u) => (
                      <tr key={u.route_id} className={opTr}>
                        <td className={cn(opTd, 'font-mono')}>#{u.route_id}</td>
                        <td className={opTd}>{u.stream_id ?? '—'}</td>
                        <td className={opTd}>{formatPct(u.failure_rate)}</td>
                        <td className={opTd}>{u.sample_total}</td>
                        <td className={opTd}>
                          <Link
                            className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
                            to={logsExplorerPath({
                              route_id: u.route_id,
                              stream_id: u.stream_id ?? undefined,
                              destination_id: u.destination_id ?? undefined,
                              stage: 'route_send_failed',
                              status: 'failed',
                            })}
                          >
                            Open logs
                            <ExternalLink className="h-3 w-3" aria-hidden />
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                <Activity className="h-4 w-4 text-slate-500" aria-hidden />
                Retry-heavy streams
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className={opTable}>
                <thead>
                  <tr className={opThRow}>
                    <th className={opTh}>Stream</th>
                    <th className={opTh}>Retry events</th>
                    <th className={opTh}>Retry sum</th>
                    <th className={opTh}>Logs</th>
                  </tr>
                </thead>
                <tbody>
                  {retryRank.retry_heavy_streams.length === 0 ? (
                    <tr className={opTr}>
                      <td className={opTd} colSpan={4}>
                        No retry outcomes in this window.
                      </td>
                    </tr>
                  ) : (
                    retryRank.retry_heavy_streams.map((s) => (
                      <tr key={s.stream_id} className={opTr}>
                        <td className={cn(opTd, 'font-mono')}>#{s.stream_id}</td>
                        <td className={opTd}>{s.retry_event_count}</td>
                        <td className={opTd}>{s.retry_column_sum}</td>
                        <td className={opTd}>
                          <Link
                            className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
                            to={logsExplorerPath({
                              stream_id: s.stream_id,
                              stage: 'route_retry_failed',
                              status: 'retry',
                            })}
                          >
                            Open logs
                            <ExternalLink className="h-3 w-3" aria-hidden />
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
              <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Retry-heavy routes</h2>
            </div>
            <div className="overflow-x-auto">
              <table className={opTable}>
                <thead>
                  <tr className={opThRow}>
                    <th className={opTh}>Route</th>
                    <th className={opTh}>Retry events</th>
                    <th className={opTh}>Logs</th>
                  </tr>
                </thead>
                <tbody>
                  {retryRank.retry_heavy_routes.length === 0 ? (
                    <tr className={opTr}>
                      <td className={opTd} colSpan={3}>
                        No retry outcomes in this window.
                      </td>
                    </tr>
                  ) : (
                    retryRank.retry_heavy_routes.map((r) => (
                      <tr key={r.route_id} className={opTr}>
                        <td className={cn(opTd, 'font-mono')}>#{r.route_id}</td>
                        <td className={opTd}>{r.retry_event_count}</td>
                        <td className={opTd}>
                          <Link
                            className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
                            to={logsExplorerPath({
                              route_id: r.route_id,
                              stage: 'route_retry_failed',
                              status: 'retry',
                            })}
                          >
                            Open logs
                            <ExternalLink className="h-3 w-3" aria-hidden />
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
