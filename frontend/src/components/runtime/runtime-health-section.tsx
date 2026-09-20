import { ExternalLink, HeartPulse, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchDestinationHealthList,
  fetchHealthOverview,
  fetchRouteHealthList,
  fetchStreamHealthList,
  type HealthQueryParams,
} from '../../api/gdcRuntimeHealth'
import type { DestinationHealthRow, HealthOverviewResponse, RouteHealthRow, StreamHealthRow } from '../../api/types/gdcApi'
import { logsExplorerPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { HealthBadge } from './operational-health/health-badge'

export { HealthBadge } from './operational-health/health-badge'

function ScoreCard({
  label,
  score,
  hint,
}: {
  label: string
  score: number | null
  hint?: string
}) {
  const display = score == null ? '—' : score.toFixed(1)
  return (
    <div className="rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-50">{display}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">{hint}</p> : null}
    </div>
  )
}

function LevelStripe({
  label,
  counts,
}: {
  label: string
  counts: { healthy: number; degraded: number; unhealthy: number; critical: number; scored?: number; total?: number }
}) {
  const scored = scoredCount(counts)
  const total = totalCount(counts)
  return (
    <div className="rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
        <span className="font-mono text-[10px] text-slate-500">
          {scored} scored / {total} total
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-1 text-center dark:border-emerald-700/40 dark:bg-emerald-900/20">
          <p className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300">{counts.healthy}</p>
          <p className="text-[9px] uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Healthy</p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-1 text-center dark:border-amber-700/40 dark:bg-amber-900/20">
          <p className="font-mono text-sm font-semibold text-amber-700 dark:text-amber-200">{counts.degraded}</p>
          <p className="text-[9px] uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">Degraded</p>
        </div>
        <div className="rounded-md border border-orange-200 bg-orange-50 px-1.5 py-1 text-center dark:border-orange-700/40 dark:bg-orange-900/20">
          <p className="font-mono text-sm font-semibold text-orange-700 dark:text-orange-200">{counts.unhealthy}</p>
          <p className="text-[9px] uppercase tracking-wide text-orange-700/80 dark:text-orange-300/80">Unhealthy</p>
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50 px-1.5 py-1 text-center dark:border-rose-700/40 dark:bg-rose-900/20">
          <p className="font-mono text-sm font-semibold text-rose-700 dark:text-rose-200">{counts.critical}</p>
          <p className="text-[9px] uppercase tracking-wide text-rose-700/80 dark:text-rose-300/80">Critical</p>
        </div>
      </div>
    </div>
  )
}

function scoringModeLabel(mode: HealthOverviewResponse['scoring_mode']): string {
  return mode === 'historical_analytics' ? 'Historical analytics (full window)' : 'Live runtime posture'
}

function scoredCount(counts: {
  healthy: number
  degraded: number
  unhealthy: number
  critical: number
  scored?: number
}): number {
  return counts.scored ?? counts.healthy + counts.degraded + counts.unhealthy + counts.critical
}

function totalCount(counts: {
  healthy: number
  degraded: number
  unhealthy: number
  critical: number
  idle?: number
  disabled?: number
  scored?: number
  total?: number
}): number {
  return counts.total ?? scoredCount(counts) + (counts.idle ?? 0) + (counts.disabled ?? 0)
}

function HealthSummaryBanner({ overview }: { overview: HealthOverviewResponse }) {
  const bad =
    overview.streams.unhealthy +
    overview.streams.critical +
    overview.routes.unhealthy +
    overview.routes.critical +
    overview.destinations.unhealthy +
    overview.destinations.critical
  const isHealthy = bad === 0
  return (
    <div
      data-testid="runtime-health-banner"
      className={cn(
        'flex items-start gap-2 rounded-xl border px-3 py-2 shadow-sm',
        isHealthy
          ? 'border-emerald-300/60 bg-emerald-50/60 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-900/30 dark:text-emerald-100'
          : 'border-amber-300/60 bg-amber-50/70 text-amber-900 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-100',
      )}
    >
      <HeartPulse className="mt-0.5 h-4 w-4" aria-hidden />
      <div className="flex-1 text-[12px] leading-snug">
        {isHealthy ? (
          <span>
            All scored entities are HEALTHY ({scoringModeLabel(overview.scoring_mode)}, {overview.time.window}).
          </span>
        ) : (
          <span>
            {bad} entity{bad === 1 ? '' : 'ies'} need attention (UNHEALTHY or CRITICAL) — {scoringModeLabel(overview.scoring_mode)},{' '}
            {overview.time.window}.
          </span>
        )}
      </div>
    </div>
  )
}

export function RuntimeHealthSection({ query, enabled = true }: { query: HealthQueryParams; enabled?: boolean }) {
  const [overview, setOverview] = useState<HealthOverviewResponse | null>(null)
  const [streams, setStreams] = useState<StreamHealthRow[]>([])
  const [routes, setRoutes] = useState<RouteHealthRow[]>([])
  const [destinations, setDestinations] = useState<DestinationHealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const [o, s, r, d] = await Promise.all([
          fetchHealthOverview({ ...query, worst_limit: 10 }),
          fetchStreamHealthList(query),
          fetchRouteHealthList(query),
          fetchDestinationHealthList(query),
        ])
        if (cancelled) return
        setOverview(o)
        setStreams(s?.rows ?? [])
        setRoutes(r?.rows ?? [])
        setDestinations(d?.rows ?? [])
        if (o == null || s == null || r == null || d == null) {
          setError('Could not load health data (API unavailable or unauthorized).')
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [query, enabled])

  const topUnhealthyRoutes = useMemo(
    () => routes.filter((r) => r.level === 'UNHEALTHY' || r.level === 'CRITICAL').slice(0, 8),
    [routes],
  )
  const topDegradedStreams = useMemo(
    () =>
      streams
        .filter((s) => s.level === 'DEGRADED' || s.level === 'UNHEALTHY' || s.level === 'CRITICAL')
        .slice(0, 8),
    [streams],
  )
  const destinationsForTable = useMemo(
    () => destinations.slice(0, 12),
    [destinations],
  )

  if (!enabled) {
    return null
  }

  if (loading && overview == null) {
    return (
      <div
        data-testid="runtime-health-loading"
        className="rounded-xl border border-slate-200/80 bg-white p-3 text-[12px] text-slate-500 dark:border-gdc-border dark:bg-gdc-card"
      >
        Loading runtime health…
      </div>
    )
  }

  if (overview == null) {
    return error ? (
      <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-100">
        {error}
      </div>
    ) : null
  }

  return (
    <section
      data-testid="runtime-health-section"
      className="flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Runtime health</h2>
          <span className="rounded-md border border-slate-200/90 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            window {overview.time.window}
          </span>
          <span className="rounded-md border border-violet-200/90 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-800 dark:border-violet-800/50 dark:bg-violet-950/40 dark:text-violet-200">
            {scoringModeLabel(overview.scoring_mode)}
          </span>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
          Deterministic scoring · 0..100 · HEALTHY ≥ 90 · CRITICAL &lt; 40 · live metrics use recent posture + recovery
        </p>
      </header>

      <HealthSummaryBanner overview={overview} />

      <p className="rounded-lg border border-slate-200/80 bg-white px-3 py-2 text-[11px] text-slate-600 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted">
        Idle entities with no delivery outcomes in the selected window are excluded from historical health scoring.
      </p>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <ScoreCard
          label="Avg stream score"
          score={overview.average_stream_score}
          hint={`${scoredCount(overview.streams)} scored / ${totalCount(overview.streams)} total streams`}
        />
        <ScoreCard
          label="Avg route score"
          score={overview.average_route_score}
          hint={`${scoredCount(overview.routes)} scored / ${totalCount(overview.routes)} total routes · ${
            overview.routes.idle ?? 0
          } idle · ${overview.routes.disabled ?? 0} disabled`}
        />
        <ScoreCard
          label="Avg destination score"
          score={overview.average_destination_score}
          hint={`${scoredCount(overview.destinations)} scored / ${totalCount(overview.destinations)} total destinations`}
        />
      </div>

      <div className="grid gap-2 lg:grid-cols-3">
        <LevelStripe label="Streams" counts={overview.streams} />
        <LevelStripe label="Routes" counts={overview.routes} />
        <LevelStripe label="Destinations" counts={overview.destinations} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
            <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
              Top unhealthy routes
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className={opTable} data-testid="runtime-health-routes-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Route</th>
                  <th className={opTh}>Stream</th>
                  <th className={opTh}>Health</th>
                  <th className={opTh}>Failures</th>
                  <th className={opTh}>Logs</th>
                </tr>
              </thead>
              <tbody>
                {topUnhealthyRoutes.length === 0 ? (
                  <tr className={opTr}>
                    <td className={opTd} colSpan={5}>
                      No unhealthy routes in this window.
                    </td>
                  </tr>
                ) : (
                  topUnhealthyRoutes.map((r) => (
                    <tr key={r.route_id} className={opTr}>
                      <td className={cn(opTd, 'font-mono')}>#{r.route_id}</td>
                      <td className={opTd}>{r.stream_id ?? '—'}</td>
                      <td className={opTd}>
                        <HealthBadge level={r.level} score={r.score} factors={r.factors} />
                      </td>
                      <td className={opTd}>
                        {r.metrics.failure_count}/{r.metrics.failure_count + r.metrics.success_count}
                      </td>
                      <td className={opTd}>
                        <Link
                          className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
                          to={logsExplorerPath({
                            route_id: r.route_id,
                            stream_id: r.stream_id ?? undefined,
                            destination_id: r.destination_id ?? undefined,
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
          <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
            <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
              Top degraded streams
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className={opTable} data-testid="runtime-health-streams-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Stream</th>
                  <th className={opTh}>Health</th>
                  <th className={opTh}>Failures</th>
                  <th className={opTh}>Retries</th>
                  <th className={opTh}>Logs</th>
                </tr>
              </thead>
              <tbody>
                {topDegradedStreams.length === 0 ? (
                  <tr className={opTr}>
                    <td className={opTd} colSpan={5}>
                      No degraded streams in this window.
                    </td>
                  </tr>
                ) : (
                  topDegradedStreams.map((s) => (
                    <tr key={s.stream_id} className={opTr}>
                      <td className={opTd}>
                        <span className="font-mono">#{s.stream_id}</span>
                        {s.stream_name ? (
                          <span className="ml-1.5 text-slate-500">{s.stream_name}</span>
                        ) : null}
                      </td>
                      <td className={opTd}>
                        <HealthBadge level={s.level} score={s.score} factors={s.factors} />
                      </td>
                      <td className={opTd}>{s.metrics.failure_count}</td>
                      <td className={opTd}>{s.metrics.retry_event_count}</td>
                      <td className={opTd}>
                        <Link
                          className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
                          to={logsExplorerPath({
                            stream_id: s.stream_id,
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
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
          <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
            Destination health
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className={opTable} data-testid="runtime-health-destinations-table">
            <thead>
              <tr className={opThRow}>
                <th className={opTh}>Destination</th>
                <th className={opTh}>Type</th>
                <th className={opTh}>Health</th>
                <th className={opTh}>Last failure</th>
                <th className={opTh}>Last success</th>
                <th className={opTh}>p95 latency</th>
                <th className={opTh}>Logs</th>
              </tr>
            </thead>
            <tbody>
              {destinationsForTable.length === 0 ? (
                <tr className={opTr}>
                  <td className={opTd} colSpan={7}>
                    No destination delivery activity in this window.
                  </td>
                </tr>
              ) : (
                destinationsForTable.map((d) => (
                  <tr key={d.destination_id} className={opTr}>
                    <td className={opTd}>
                      <span className="font-mono">#{d.destination_id}</span>
                      {d.destination_name ? (
                        <span className="ml-1.5 text-slate-500">{d.destination_name}</span>
                      ) : null}
                    </td>
                    <td className={opTd}>{d.destination_type ?? '—'}</td>
                    <td className={opTd}>
                      <HealthBadge level={d.level} score={d.score} factors={d.factors} />
                    </td>
                    <td className={opTd}>{d.metrics.last_failure_at ?? '—'}</td>
                    <td className={opTd}>{d.metrics.last_success_at ?? '—'}</td>
                    <td className={opTd}>
                      {d.metrics.latency_ms_p95 != null ? `${Math.round(d.metrics.latency_ms_p95)} ms` : '—'}
                    </td>
                    <td className={opTd}>
                      <Link
                        className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
                        to={logsExplorerPath({
                          destination_id: d.destination_id,
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
    </section>
  )
}
