import { AlertTriangle, ChevronRight, Clock, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { OperationalProblem } from '../../api/operationalSnapshot'
import type { MetricsWindow } from '../../api/gdcRuntime'
import { useDebouncedValue } from '../../hooks/use-debounced-value'
import { useDeferredMount } from '../../hooks/use-deferred-mount'
import { filterOperationalStreams, type StreamTopologyGroupMode } from '../../lib/runtime-stream-selectors'
import { recordRuntimeSectionRender } from '../../lib/runtime-ui-instrumentation'
import { cn } from '../../lib/utils'
import { logsExplorerPath, newStreamPath, streamEditPath, streamRuntimePath } from '../../config/nav-paths'
import { StatusBadge } from '../shell/status-badge'
import {
  useRuntimeOperational,
  useRuntimeOperationalMeta,
  useRuntimeOperationalSnapshot,
} from './runtime-operational-provider'
import {
  countHealthBuckets,
  countStreamsByTab,
  destinationTypeDistribution,
  failedRoutes,
  formatEps,
  formatLatencyMs,
  formatPercent,
  formatShortTs,
  operationalHealthLabel,
  operationalHealthStripClass,
  operationalHealthTone,
  retryHeavyRoutes,
  sortProblems,
  type StreamHealthTab,
} from './runtime-overview-helpers'
import { VirtualizedStreamGrid } from './virtualized-stream-grid'
import { HelpTooltip } from '../ui/help-tooltip'
import { HELP_COPY } from '../ui/help-tooltip-copy'
import { OP_LABEL } from '../../lib/operator-vocabulary'

function GlobalHealthStrip() {
  const { loading, lastUpdatedAt } = useRuntimeOperationalMeta()
  const { snapshot } = useRuntimeOperationalSnapshot()
  recordRuntimeSectionRender('GlobalHealthStrip')
  const g = snapshot?.global

  if (loading && g == null) {
    return (
      <section
        aria-label="Global health"
        className="flex items-center justify-center gap-2 rounded-xl border border-slate-200/80 bg-white px-4 py-6 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      >
        <Loader2 className="h-4 w-4 animate-spin text-violet-500" aria-hidden />
        <span className="text-[12px] text-slate-500">Loading operational snapshot…</span>
      </section>
    )
  }

  if (!g) return null

  const items = [
    { label: 'Streams', value: `${g.enabled_streams}/${g.total_streams} enabled` },
    { label: 'Running', value: String(g.running_streams) },
    { label: 'Errors', value: String(g.error_streams) },
    { label: OP_LABEL.deliveryPaths, value: `${g.enabled_routes}/${g.total_routes}` },
    { label: 'Destinations', value: `${g.enabled_destinations}/${g.total_destinations}` },
    { label: 'EPS 1m', value: formatEps(g.total_eps_1m) },
    { label: 'EPS 5m', value: formatEps(g.total_eps_5m) },
    { label: 'Avg latency', value: formatLatencyMs(g.avg_latency_ms) },
    { label: 'Last activity', value: formatShortTs(g.last_activity_at) },
    { label: 'Updated', value: formatShortTs(lastUpdatedAt ?? snapshot?.updated_at) },
  ]

  return (
    <section
      aria-label="Global health"
      data-testid="runtime-global-health-strip"
      className={cn(
        'rounded-xl border px-3 py-3 shadow-sm',
        operationalHealthStripClass(g.health_status),
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">Platform</span>
          <StatusBadge tone={operationalHealthTone(g.health_status)}>{operationalHealthLabel(g.health_status)}</StatusBadge>
        </div>
        <div className="hidden h-5 w-px bg-current/20 sm:block" aria-hidden />
        <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-10">
          {items.map((item) => (
            <div key={item.label} className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">{item.label}</p>
              <p className="truncate text-[12px] font-semibold tabular-nums">{item.value}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

const TOPOLOGY_OPTIONS: { value: StreamTopologyGroupMode; label: string }[] = [
  { value: 'health', label: 'Health' },
  { value: 'connector', label: 'Source product' },
  { value: 'destination', label: 'Delivery target type' },
  { value: 'none', label: 'Flat' },
]

function StreamFlowGrid({
  focusStreamId,
  onFocusStream,
}: {
  focusStreamId: number | null
  onFocusStream: (id: number) => void
}) {
  const { loading } = useRuntimeOperationalMeta()
  const { snapshot } = useRuntimeOperationalSnapshot()
  const streams = snapshot?.streams ?? []
  const routes = snapshot?.routes ?? []
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 200)
  const [tab, setTab] = useState<StreamHealthTab>('all')
  const [groupMode, setGroupMode] = useState<StreamTopologyGroupMode>('health')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())

  recordRuntimeSectionRender('StreamFlowGrid')

  const counts = useMemo(() => countStreamsByTab(streams), [streams])

  const filtered = useMemo(
    () => filterOperationalStreams(streams, tab, debouncedSearch),
    [streams, tab, debouncedSearch],
  )

  const onToggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }, [])

  const onFocusStreamStable = useCallback((id: number) => onFocusStream(id), [onFocusStream])

  return (
    <section
      aria-label="Stream flow"
      data-testid="runtime-stream-flow-grid"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Stream flow</h2>
        <label className="flex items-center gap-1 text-[10px] font-medium text-slate-500">
          <span className="sr-only">Group by</span>
          <select
            value={groupMode}
            onChange={(e) => setGroupMode(e.target.value as StreamTopologyGroupMode)}
            className="h-8 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] dark:border-gdc-border dark:bg-gdc-card"
            aria-label="Group streams by"
          >
            {TOPOLOGY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="relative max-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            type="search"
            placeholder="Search…"
            className="h-8 w-full rounded-md border border-slate-200/90 bg-white py-1 pl-8 pr-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
            aria-label="Search streams"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-slate-100 px-2 py-2 dark:border-gdc-divider">
        {(
          [
            ['all', `All ${counts.all}`],
            ['healthy', `Healthy ${counts.healthy}`],
            ['degraded', `Degraded ${counts.degraded}`],
            ['error', `Error ${counts.error}`],
            ['idle', `Idle ${counts.idle}`],
            ['disabled', `Off ${counts.disabled}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] font-semibold transition',
              tab === k
                ? 'bg-violet-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {loading && streams.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading streams…
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-[12px] text-slate-500">No streams match filters.</p>
      ) : (
        <VirtualizedStreamGrid
          streams={filtered}
          routes={routes}
          focusStreamId={focusStreamId}
          onFocusStream={onFocusStreamStable}
          groupMode={groupMode}
          collapsedGroups={collapsedGroups}
          onToggleGroup={onToggleGroup}
        />
      )}
    </section>
  )
}

const ProblemRow = memo(function ProblemRow({ problem }: { problem: OperationalProblem }) {
  const tone =
    problem.severity === 'critical'
      ? 'border-red-200/80 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/25'
      : 'border-amber-200/80 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/25'
  return (
    <li className={cn('rounded-lg border px-2.5 py-2', tone)} data-testid={`runtime-problem-${problem.severity}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:text-gdc-muted">{problem.severity}</span>
        <span className="text-[10px] font-semibold uppercase text-slate-500">{problem.scope}</span>
        <span className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">{problem.title}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">{problem.message}</p>
      <p className="mt-1 text-[10px] text-slate-500">{formatShortTs(problem.last_seen_at)}</p>
    </li>
  )
})

function ProblemInsightPanel({ onFocusProblem }: { onFocusProblem: (problem: OperationalProblem) => void }) {
  const { snapshot } = useRuntimeOperationalSnapshot()
  const problems = useMemo(() => sortProblems(snapshot?.problems ?? []), [snapshot?.problems])

  return (
    <section
      aria-label="Problems"
      data-testid="runtime-problem-panel"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Problem insight</h2>
        <span className="text-[11px] font-medium text-slate-500">{problems.length} active</span>
      </div>
      <ul className="max-h-[280px] space-y-2 overflow-y-auto p-3">
        {problems.length === 0 ? (
          <li className="text-[12px] text-slate-500">No operational problems in this snapshot.</li>
        ) : (
          problems.slice(0, 24).map((p, i) => (
            <button key={`${p.title}-${i}`} type="button" className="block w-full text-left" onClick={() => onFocusProblem(p)}>
              <ProblemRow problem={p} />
            </button>
          ))
        )}
      </ul>
    </section>
  )
}

function RouteDestinationHealthSummary() {
  const { snapshot } = useRuntimeOperationalSnapshot()
  const routes = snapshot?.routes ?? []
  const destinations = snapshot?.destinations ?? []
  const routeCounts = countHealthBuckets(routes)
  const destCounts = countHealthBuckets(destinations)
  const typeDist = useMemo(() => destinationTypeDistribution(destinations), [destinations])
  const failed = useMemo(() => failedRoutes(routes).slice(0, 6), [routes])
  const retryHeavy = useMemo(() => retryHeavyRoutes(routes).slice(0, 6), [routes])

  return (
    <section
      aria-label="Delivery path and destination health"
      data-testid="runtime-route-destination-summary"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Delivery path & destination health</h2>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-500">{OP_LABEL.deliveryPaths}</p>
          <p className="mt-1 text-[12px] tabular-nums text-slate-800 dark:text-slate-100">
            {routeCounts.healthy} healthy · {routeCounts.degraded} degraded · {routeCounts.error} error · {routeCounts.idle}{' '}
            idle
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-500">Destinations</p>
          <p className="mt-1 text-[12px] tabular-nums text-slate-800 dark:text-slate-100">
            {destCounts.healthy} healthy · {destCounts.degraded} degraded · {destCounts.error} error · {destCounts.idle}{' '}
            idle
          </p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-[10px] font-semibold uppercase text-slate-500">Destination types</p>
          <p className="mt-1 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
            {typeDist.length
              ? typeDist.map((d) => `${d.type} (${d.count})`).join(' · ')
              : 'No destinations in snapshot.'}
          </p>
        </div>
        {failed.length > 0 ? (
          <div className="sm:col-span-2">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase text-red-800 dark:text-red-300">
              Failed / degraded routes
              <HelpTooltip content={HELP_COPY.runtimeRouteFailure.content} ariaLabel="Route failure help" />
            </p>
            <ul className="mt-1 space-y-1">
              {failed.map((r) => (
                <li key={r.route_id} className="text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
                  R-{r.route_id} · {r.stream_name ?? `stream ${r.stream_id}`} → {r.destination_name ?? 'destination'}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {retryHeavy.length > 0 ? (
          <div className="sm:col-span-2">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase text-amber-800 dark:text-amber-200">
              Retry-heavy routes
              <HelpTooltip content={HELP_COPY.runtimeRetry.content} ariaLabel="Retry help" />
            </p>
            <ul className="mt-1 space-y-1">
              {retryHeavy.map((r) => (
                <li key={r.route_id} className="text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
                  R-{r.route_id} · retry {formatPercent(r.retry_rate_5m)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function LazyAnalyticsSection({
  focusStreamId,
  metricsWindow,
}: {
  focusStreamId: number | null
  metricsWindow: MetricsWindow
}) {
  const { snapshot } = useRuntimeOperationalSnapshot()
  const chartsReady = useDeferredMount(80)
  const [requested, setRequested] = useState(false)
  const [loading, setLoading] = useState(false)
  const [chartData, setChartData] = useState<{ name: string; total: number }[]>([])

  const loadAnalytics = async () => {
    if (focusStreamId == null) return
    setRequested(true)
    setLoading(true)
    try {
      const { fetchStreamRuntimeMetrics } = await import('../../api/gdcRuntime')
      const m = await fetchStreamRuntimeMetrics(focusStreamId, metricsWindow)
      const points = m?.events_over_time ?? []
      setChartData(
        points.map((p) => ({
          name: formatShortTs(p.timestamp),
          total: p.events ?? 0,
        })),
      )
    } catch {
      setChartData([])
    } finally {
      setLoading(false)
    }
  }

  const streamName =
    focusStreamId != null
      ? snapshot?.streams.find((s) => s.stream_id === focusStreamId)?.stream_name ?? `#${focusStreamId}`
      : null

  return (
    <section
      aria-label="Analytics"
      data-testid="runtime-lazy-analytics"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Delivery analytics (lazy)</h2>
        <button
          type="button"
          disabled={focusStreamId == null || loading}
          onClick={() => void loadAnalytics()}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2.5 text-[11px] font-semibold text-violet-900 disabled:opacity-40 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          Load chart
        </button>
      </div>
      <div className="p-3">
        {!requested ? (
          <p className="text-[12px] text-slate-500">
            Select a stream and load analytics for timeline charts. Initial command center view uses the operational snapshot
            only.
          </p>
        ) : focusStreamId == null ? (
          <p className="text-[12px] text-slate-500">Select a stream to load analytics.</p>
        ) : (
          <>
            <p className="mb-2 text-[11px] text-slate-600 dark:text-gdc-muted">{streamName} · window {metricsWindow}</p>
            <div className="h-[200px] w-full">
              {loading ? (
                <div className="flex h-full items-center justify-center gap-2 text-[12px] text-slate-500">
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                  Loading metrics…
                </div>
              ) : chartData.length === 0 ? (
                <p className="flex h-full items-center justify-center text-[12px] text-slate-500">No timeline data.</p>
              ) : chartsReady ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData.slice(0, 120)} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--gdc-chart-muted)' }} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--gdc-chart-muted)' }} width={32} />
                    <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                    <Line type="monotone" dataKey="total" stroke="var(--gdc-chart-primary)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-[12px] text-slate-500">Preparing chart…</div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

export function RuntimeCommandCenterSections({
  focusStreamId,
  onFocusStream,
  onFocusProblem,
  metricsWindow,
}: {
  focusStreamId: number | null
  onFocusStream: (id: number) => void
  onFocusProblem: (problem: OperationalProblem) => void
  metricsWindow: MetricsWindow
}) {
  const sidePanelsReady = useDeferredMount(48)
  const analyticsReady = useDeferredMount(120)

  return (
    <div className="space-y-4">
      <GlobalHealthStrip />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <StreamFlowGrid focusStreamId={focusStreamId} onFocusStream={onFocusStream} />
        </div>
        <div className="space-y-4 xl:col-span-4">
          {sidePanelsReady ? (
            <>
              <ProblemInsightPanel onFocusProblem={onFocusProblem} />
              <RouteDestinationHealthSummary />
            </>
          ) : (
            <div className="rounded-xl border border-slate-200/80 bg-white px-3 py-8 text-center text-[12px] text-slate-500 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              Loading panels…
            </div>
          )}
        </div>
      </div>
      {analyticsReady ? (
        <LazyAnalyticsSection focusStreamId={focusStreamId} metricsWindow={metricsWindow} />
      ) : null}
    </div>
  )
}

export function RuntimeOverviewHeader({
  metricsWindow,
  onMetricsWindowChange,
}: {
  metricsWindow: MetricsWindow
  onMetricsWindowChange: (w: MetricsWindow) => void
}) {
  const { loading, error, refresh, refreshEvery, setRefreshEvery, snapshot } = useRuntimeOperational()
  const running = snapshot?.global.running_streams ?? 0

  return (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{OP_LABEL.streamMonitoring}</h1>
        <p className="max-w-xl text-[13px] text-slate-600 dark:text-gdc-muted">
          Per-stream operational snapshot: flow, problems, and route/destination health. Analytics load on demand.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          {running} running
        </span>
        <div className="inline-flex items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
          <Clock className="h-3 w-3 text-slate-400" aria-hidden />
          <select
            value={metricsWindow}
            onChange={(e) => onMetricsWindowChange(e.target.value as MetricsWindow)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium focus:outline-none"
            aria-label="Analytics window"
          >
            <option value="15m">15m (analytics)</option>
            <option value="1h">1h (analytics)</option>
            <option value="6h">6h (analytics)</option>
            <option value="24h">24h (analytics)</option>
          </select>
        </div>
        <div className="inline-flex items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
          <RefreshCw className="h-3 w-3 text-slate-400" aria-hidden />
          <select
            value={refreshEvery}
            onChange={(e) => setRefreshEvery(e.target.value as typeof refreshEvery)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium focus:outline-none"
            aria-label="Snapshot refresh interval"
          >
            <option value="10s">10s</option>
            <option value="30s">30s</option>
            <option value="1m">1m</option>
            <option value="off">Off</option>
          </select>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={refresh}
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2.5 text-[12px] font-semibold shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
          Refresh
        </button>
        <Link
          to={newStreamPath()}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
        >
          + New stream
        </Link>
      </div>
      {error ? (
        <div role="alert" data-testid="runtime-load-error" className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100">
          {error}
        </div>
      ) : null}
    </header>
  )
}

export function RuntimeStreamFocusAside({
  focusStreamId,
  highlightRouteId,
}: {
  focusStreamId: number | null
  highlightRouteId: number | null
}) {
  const { streamsById } = useRuntimeOperationalSnapshot()
  const stream = focusStreamId != null ? (streamsById.get(focusStreamId) ?? null) : null

  if (stream == null) {
    return (
      <aside className="rounded-xl border border-slate-200/80 bg-white p-3 text-[12px] text-slate-500 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        Select a stream card to focus controls and links.
      </aside>
    )
  }

  return (
    <aside className="space-y-3" aria-label="Stream focus">
      <section className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">{stream.stream_name}</h2>
          <StatusBadge tone={operationalHealthTone(stream.health_status)}>{operationalHealthLabel(stream.health_status)}</StatusBadge>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <dt className="flex items-center gap-1 text-slate-500">
              EPS 1m / 5m
              <HelpTooltip content={HELP_COPY.runtimeEps.content} ariaLabel="EPS help" />
            </dt>
            <dd className="font-medium tabular-nums">
              {formatEps(stream.eps_1m)} / {formatEps(stream.eps_5m)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Success / fail</dt>
            <dd className="font-medium tabular-nums">
              {formatPercent(stream.success_rate_5m)} / {formatPercent(stream.failure_rate_5m)}
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-slate-500">
              Sync position lag
              <HelpTooltip content={HELP_COPY.runtimeCheckpoint.content} ariaLabel="Sync position help" />
            </dt>
            <dd className="font-medium tabular-nums">{stream.checkpoint_lag_seconds != null ? `${stream.checkpoint_lag_seconds}s` : '—'}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-slate-500">
              {OP_LABEL.deliveryPaths}
              <HelpTooltip content={HELP_COPY.runtimeRouteFailure.content} ariaLabel="Delivery path failure help" />
            </dt>
            <dd className="font-medium">
              {stream.healthy_route_count} OK · {stream.failed_route_count} failed / {stream.route_count}
            </dd>
          </div>
        </dl>
        {highlightRouteId != null ? (
          <p className="mt-2 text-[10px] text-violet-800 dark:text-violet-200">URL focus: delivery path #{highlightRouteId}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to={streamRuntimePath(String(stream.stream_id))}
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200"
          >
            Open runtime
          </Link>
          <Link
            to={streamEditPath(String(stream.stream_id))}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
          >
            Settings
          </Link>
          <Link
            to={logsExplorerPath({ stream_id: stream.stream_id })}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
          >
            Logs
          </Link>
        </div>
      </section>
      <div className="rounded-lg border border-amber-200/80 bg-amber-500/[0.06] p-2 text-[11px] text-amber-950 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-100">
        <AlertTriangle className="mb-1 inline h-3.5 w-3.5" aria-hidden />
        Start/stop/run-once controls remain on the stream runtime page; this overview avoids per-stream polling.
      </div>
    </aside>
  )
}

export function RuntimeUrlFilterChips({
  queryStreamId,
  queryRouteId,
  queryDestinationId,
  streamName,
  onRemove,
}: {
  queryStreamId: number | null
  queryRouteId: number | null
  queryDestinationId: number | null
  streamName: string | null
  onRemove: (key: 'stream_id' | 'route_id' | 'destination_id') => void
}) {
  if (queryStreamId == null && queryRouteId == null && queryDestinationId == null) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Context</span>
      {queryStreamId != null ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-300/40 bg-slate-500/[0.06] py-0.5 pl-2 pr-1 text-[11px] font-medium">
          Stream · {streamName ?? `#${queryStreamId}`}
          <button type="button" aria-label="Remove stream filter" onClick={() => onRemove('stream_id')}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ) : null}
      {queryRouteId != null ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-300/40 py-0.5 pl-2 pr-1 text-[11px]">
          {OP_LABEL.deliveryPath} · #{queryRouteId}
          <button type="button" aria-label="Remove route filter" onClick={() => onRemove('route_id')}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ) : null}
      {queryDestinationId != null ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-300/40 py-0.5 pl-2 pr-1 text-[11px]">
          Destination · #{queryDestinationId}
          <button type="button" aria-label="Remove destination filter" onClick={() => onRemove('destination_id')}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ) : null}
    </div>
  )
}
