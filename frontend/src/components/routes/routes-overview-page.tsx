import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { testDestination } from '../../api/gdcDestinations'
import {
  clearOperationalSnapshotCache,
  getOperationalSnapshot,
  type OperationalSnapshotResponse,
} from '../../api/operationalSnapshot'
import {
  fetchRoutesList,
  type RouteRead,
} from '../../api/gdcRoutes'
import { type MetricsWindow } from '../../api/gdcRuntime'
import type { StreamRead } from '../../api/types/gdcApi'
import { routeEditPath } from '../../config/nav-paths'
import {
  aggregateDeliverySuccessRateFromSnapshot,
  formatOperationalEps,
  formatOperationalSuccessRate,
  selectGlobalKpi,
} from '../../lib/operational-snapshot-selectors'
import { cn } from '../../lib/utils'
import { useDebouncedValue } from '../../hooks/use-debounced-value'
import { useDocumentVisible } from '../../hooks/use-document-visible'
import { useVirtualWindow } from '../../hooks/use-virtual-window'
import { stabilizeOperationalSnapshot, type StabilizedOperationalSnapshot } from '../../lib/snapshot-stabilize'
import { GDC_HEADER_REFRESH_EVENT } from '../layout/header-refresh-event'
import {
  logOperationalSnapshotRefresh,
  logOperationalSnapshotRefreshSuppressed,
  logOperationalSnapshotVisibility,
} from '../../lib/operational-snapshot-debug'
import { opStateRow, opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  buildRouteRowsFromOperationalSnapshot,
  filterRouteConsoleRows,
  formatFailurePolicy,
  relativeShort,
} from './routes-overview-helpers'
import { aggregateGlobalErrorRateFromRoutes } from './routes-flow-helpers'
import { RoutesDestinationMetricsPanel } from './routes-destination-metrics-panel'
import { RoutesFlowTreeTable } from './routes-flow-tree-table'
import { RoutesProblemRoutesPanel } from './routes-problem-routes-panel'
import { RuntimeFixtureModeBanner } from '../runtime/runtime-fixture-mode-banner'
import { ROUTES_TABLE_ROW_HEIGHT, ROUTES_VIRTUAL_SCROLL_THRESHOLD, RoutesTableRow } from './routes-table-row'
import { PagePurposeHeader, type PageHelpContent } from '../ui/page-purpose-header'
import { StreamFlowMap } from '../flow/stream-flow-map'

const WINDOW_OPTIONS: { value: MetricsWindow; label: string }[] = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last 1 hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
]

const ROUTES_HELP: PageHelpContent = {
  title: 'Routes',
  intro: 'A Route is the destination-specific delivery path from one Stream to one Destination. Use Routes when the same Stream needs different processing or delivery behavior for different destinations.',
  sections: [
    {
      title: 'The core model',
      bullets: [
        'One Stream collects a data flow once.',
        'That Stream can fan out through many Routes.',
        'Each Route targets one Destination and owns destination-specific processing and failure behavior.',
      ],
    },
    {
      title: 'What am I looking at?',
      body: 'The flow view shows how Streams fan out to Destinations. KPI and route tables show runtime-backed throughput, delivery success, errors, latency, and route configuration.',
    },
    {
      title: 'What should I do next?',
      body: 'Investigate unhealthy Routes first. Create a Route only when an existing Stream needs another Destination or different destination-specific processing.',
    },
  ],
}

function MiniSparkline({ values, className }: { values: readonly number[]; className?: string }) {
  const w = 52
  const h = 18
  const padX = 2
  const padY = 2
  const nums = values.length ? [...values] : [0]
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const range = max - min || 1
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  const pts = nums.map((v, i) => {
    const x = padX + (i / Math.max(nums.length - 1, 1)) * innerW
    const y = padY + (1 - (v - min) / range) * innerH
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn('shrink-0 overflow-visible', className)} aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={pts.join(' ')} />
    </svg>
  )
}

function ThinProgress({ pct, toneClass }: { pct: number; toneClass: string }) {
  const width = `${Math.min(100, Math.max(0, pct))}%`
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-200/90 dark:bg-gdc-elevated">
      <div className={cn('h-full rounded-full transition-[width]', toneClass)} style={{ width }} />
    </div>
  )
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full min-w-[7.5rem] appearance-none rounded-md border border-slate-200/90 bg-white py-1 pl-2 pr-7 text-[12px] font-medium text-slate-800 shadow-none focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400/30 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:focus:border-violet-500 dark:focus:ring-violet-500/25"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" aria-hidden />
    </div>
  )
}

export function RoutesOverviewPage() {
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('1h')
  const [refreshTick, setRefreshTick] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [routesRaw, setRoutesRaw] = useState<RouteRead[]>([])
  const streamsRaw: StreamRead[] = []
  const destinationsRaw: never[] = []
  const [operationalSnapshot, setOperationalSnapshot] = useState<StabilizedOperationalSnapshot | null>(null)
  const [search, setSearch] = useState('')
  const [streamFilter, setStreamFilter] = useState('__all__')
  const [destinationFilter, setDestinationFilter] = useState('__all__')
  const [statusFilter, setStatusFilter] = useState('__all__')
  const [policyFilter, setPolicyFilter] = useState('__all__')
  const debouncedSearch = useDebouncedValue(search, 200)
  const [allRoutesExpanded, setAllRoutesExpanded] = useState(false)
  const routesTableScrollRef = useRef<HTMLDivElement>(null)
  const [routesScrollTop, setRoutesScrollTop] = useState(0)
  const [routesViewportHeight, setRoutesViewportHeight] = useState(480)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(8)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  const [showRateLimitCol, setShowRateLimitCol] = useState(true)
  const [testBusyId, setTestBusyId] = useState<number | null>(null)
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; message: string } | null>(null)
  const [moreMenuRouteId, setMoreMenuRouteId] = useState<number | null>(null)
  const loadGenerationRef = useRef(0)
  const loadInFlightRef = useRef(false)
  const refreshQueuedRef = useRef(false)
  const snapshotRef = useRef<OperationalSnapshotResponse | null>(null)
  const wasHiddenRef = useRef(false)
  const documentVisible = useDocumentVisible()

  const columnsRef = useRef<HTMLDivElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!columnsRef.current?.contains(e.target as Node)) setColumnsMenuOpen(false)
      if (!moreMenuRef.current?.contains(e.target as Node)) setMoreMenuRouteId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(t)
  }, [toast])

  snapshotRef.current = operationalSnapshot

  const loadAll = useCallback(
    async (reason: string) => {
      if (loadInFlightRef.current) {
        refreshQueuedRef.current = true
        logOperationalSnapshotRefreshSuppressed(`in-flight:${reason}`)
        return
      }
      loadInFlightRef.current = true
      const token = ++loadGenerationRef.current
      const isCurrent = () => token === loadGenerationRef.current
      const showInitialLoader = snapshotRef.current == null
      if (showInitialLoader) {
        setLoading(true)
        setLoadError(null)
      }
      try {
        const routes = await fetchRoutesList()
        if (!isCurrent()) return
        setRoutesRaw(routes ?? [])
        setLoadError(null)
        setLoading(false)

        const snapshot = await getOperationalSnapshot()
        if (!isCurrent()) return
        if (snapshot == null) {
          setLoadError('Could not load operational snapshot.')
          return
        }
        setOperationalSnapshot((prev) => stabilizeOperationalSnapshot(prev, snapshot))
        logOperationalSnapshotRefresh(reason, snapshot.updated_at)
      } catch (e) {
        if (!isCurrent()) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load routes console.')
      } finally {
        if (isCurrent()) setLoading(false)
        loadInFlightRef.current = false
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false
          void loadAll('queued')
        }
      }
    },
    [refreshTick],
  )

  useEffect(() => {
    void loadAll(refreshTick === 0 ? 'mount' : 'refresh')
  }, [loadAll])

  useEffect(() => {
    logOperationalSnapshotVisibility(!documentVisible)
    if (!documentVisible) {
      wasHiddenRef.current = true
      return
    }
    if (wasHiddenRef.current) {
      wasHiddenRef.current = false
      clearOperationalSnapshotCache()
      setRefreshTick((t) => t + 1)
    }
  }, [documentVisible])

  useEffect(() => {
    const onHeaderRefresh = () => {
      clearOperationalSnapshotCache()
      setRefreshTick((t) => t + 1)
    }
    window.addEventListener(GDC_HEADER_REFRESH_EVENT, onHeaderRefresh)
    return () => window.removeEventListener(GDC_HEADER_REFRESH_EVENT, onHeaderRefresh)
  }, [])

  const consoleRows = useMemo(() => {
    if (operationalSnapshot != null) {
      return buildRouteRowsFromOperationalSnapshot(operationalSnapshot, routesRaw, {
        streams: streamsRaw,
        destinations: destinationsRaw,
      })
    }
    return []
  }, [operationalSnapshot, routesRaw, streamsRaw, destinationsRaw])

  const streamOptions = useMemo(() => {
    const streamsById = new Map<number, string>()
    for (const row of consoleRows) {
      const streamId = row.stream?.id ?? row.route.stream_id
      const streamName = (row.stream?.name ?? '').trim() || `Stream #${streamId}`
      streamsById.set(streamId, streamName)
    }

    const nameCounts = new Map<string, number>()
    for (const streamName of streamsById.values()) {
      nameCounts.set(streamName, (nameCounts.get(streamName) ?? 0) + 1)
    }

    return [
      { value: '__all__', label: 'All Streams' },
      ...[...streamsById.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0])
        .map(([streamId, streamName]) => ({
          value: String(streamId),
          label: (nameCounts.get(streamName) ?? 0) > 1 ? `${streamName} · #${streamId}` : streamName,
        })),
    ]
  }, [consoleRows])

  const destinationOptions = useMemo(() => {
    const names = new Set<string>()
    for (const r of consoleRows) {
      const n = (r.destination?.name ?? '').trim()
      if (n) names.add(n)
    }
    return ['__all__', ...[...names].sort()]
  }, [consoleRows])

  const policyOptions = useMemo(() => {
    const p = new Set<string>()
    for (const r of consoleRows) {
      const fp = (r.route.failure_policy ?? '').trim()
      if (fp) p.add(fp)
    }
    return ['__all__', ...[...p].sort()]
  }, [consoleRows])

  const filteredRows = useMemo(
    () =>
      filterRouteConsoleRows(consoleRows, {
        searchQuery: debouncedSearch,
        streamFilter,
        destinationFilter,
        statusFilter,
        policyFilter,
        quickFilter: 'all',
        highErr: false,
        highLat: false,
      }),
    [consoleRows, debouncedSearch, streamFilter, destinationFilter, statusFilter, policyFilter],
  )

  const useRouteVirtualization = filteredRows.length >= ROUTES_VIRTUAL_SCROLL_THRESHOLD
  const virtualRange = useVirtualWindow(
    useRouteVirtualization ? filteredRows.length : 0,
    routesScrollTop,
    routesViewportHeight,
    ROUTES_TABLE_ROW_HEIGHT,
    4,
  )
  const virtualRouteRows = useMemo(() => {
    if (!useRouteVirtualization || virtualRange.endIndex < virtualRange.startIndex) return []
    return filteredRows.slice(virtualRange.startIndex, virtualRange.endIndex + 1)
  }, [useRouteVirtualization, filteredRows, virtualRange.startIndex, virtualRange.endIndex])

  const onRoutesTableScroll = useCallback(() => {
    const el = routesTableScrollRef.current
    if (el == null) return
    setRoutesScrollTop(el.scrollTop)
    setRoutesViewportHeight(el.clientHeight)
  }, [])

  const onToggleMoreMenu = useCallback(
    (routeId: number) => setMoreMenuRouteId((id) => (id === routeId ? null : routeId)),
    [],
  )
  const onCloseMoreMenu = useCallback(() => setMoreMenuRouteId(null), [])

  useEffect(() => {
    setPage(1)
  }, [search, streamFilter, destinationFilter, statusFilter, policyFilter])

  const totalFiltered = filteredRows.length
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageOffset = (safePage - 1) * pageSize
  const pageRows = filteredRows.slice(pageOffset, pageOffset + pageSize)
  const displayRows = useRouteVirtualization ? virtualRouteRows : pageRows
  const topVirtualPad =
    useRouteVirtualization && virtualRange.startIndex > 0 ? virtualRange.offsetTop : 0
  const bottomVirtualPad = useRouteVirtualization
    ? Math.max(0, virtualRange.totalSize - topVirtualPad - displayRows.length * ROUTES_TABLE_ROW_HEIGHT)
    : 0

  useEffect(() => {
    if (safePage !== page) setPage(safePage)
  }, [safePage, page])

  const globalKpi = useMemo(
    () => (operationalSnapshot != null ? selectGlobalKpi(operationalSnapshot) : null),
    [operationalSnapshot],
  )
  const deliverySuccessRate = useMemo(
    () => (operationalSnapshot != null ? aggregateDeliverySuccessRateFromSnapshot(operationalSnapshot) : null),
    [operationalSnapshot],
  )
  const globalErrorRate = useMemo(
    () => aggregateGlobalErrorRateFromRoutes(operationalSnapshot),
    [operationalSnapshot],
  )

  const totalEps = globalKpi?.eps1m ?? 0
  const throughputSpark = useMemo(() => [totalEps], [totalEps])
  const successSpark = useMemo(
    () => (deliverySuccessRate != null ? [deliverySuccessRate] : [0]),
    [deliverySuccessRate],
  )

  function clearFilters() {
    setSearch('')
    setStreamFilter('__all__')
    setDestinationFilter('__all__')
    setStatusFilter('__all__')
    setPolicyFilter('__all__')
  }

  const onTestRoute = useCallback(async (routeId: number, destinationId: number | null) => {
    if (destinationId == null || testBusyId != null) return
    setTestBusyId(routeId)
    try {
      const res = await testDestination(destinationId)
      const latencyPart =
        typeof res.latency_ms === 'number' && Number.isFinite(res.latency_ms)
          ? ` · ${res.latency_ms.toFixed(0)} ms`
          : ''
      setToast({
        tone: res.success ? 'ok' : 'err',
        message: `${res.success ? 'Destination test succeeded' : 'Destination test failed'} — ${res.message}${latencyPart}`,
      })
      setRefreshTick((x) => x + 1)
    } catch (e) {
      setToast({
        tone: 'err',
        message: e instanceof Error ? e.message : 'Destination test failed.',
      })
    } finally {
      setTestBusyId(null)
    }
  }, [testBusyId])

  const pageNumbers = useMemo(() => {
    const windowN = 3
    const start = Math.max(1, Math.min(safePage - 1, totalPages - windowN + 1))
    return Array.from({ length: Math.min(windowN, totalPages) }, (_, i) => start + i).filter((n) => n <= totalPages)
  }, [safePage, totalPages])

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      {loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-medium text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-100">
          {loadError}
        </div>
      ) : null}
      <RuntimeFixtureModeBanner surface="routes" />
      <PagePurposeHeader
        title="Routes"
        showTitle={false}
        purpose="How does each Stream reach each Destination? A Route is the destination-specific path that applies processing, delivery, retry, and rate-limit behavior before data is sent."
        help={ROUTES_HELP}
        testId="routes-purpose-header"
        actions={
          <Link
            to={routeEditPath('new')}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Create Route
          </Link>
        }
      />

      <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Route runtime controls">
        {operationalSnapshot ? (
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
              'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            SNAPSHOT
            <span className="font-normal opacity-80">
              Updated {relativeShort(operationalSnapshot.updated_at)}
            </span>
          </div>
        ) : loading ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Status…
          </span>
        ) : (
          <span className="text-[11px] text-slate-500">Runtime status unavailable</span>
        )}
        <SelectField
          id="routes-window"
          label="Metrics window"
          value={metricsWindow}
          options={WINDOW_OPTIONS}
          onChange={(v) => setMetricsWindow(v as MetricsWindow)}
        />
        <button
          type="button"
          onClick={() => {
            clearOperationalSnapshotCache()
            setRefreshTick((x) => x + 1)
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200/90 bg-white text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          aria-label="Refresh"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
        </button>
      </div>

      <section
        className="rounded-xl border border-violet-200/70 bg-violet-50/40 px-4 py-3 dark:border-violet-500/20 dark:bg-violet-500/[0.06]"
        data-testid="routes-mental-model"
        aria-label="DataRelay delivery model"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">How delivery works</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">Stream</span>
          <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="rounded-lg border border-violet-200 bg-white px-3 py-2 dark:border-violet-500/30 dark:bg-gdc-card">Route Processing</span>
          <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">Destination</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-gdc-muted">
          One Stream can fan out through many Routes to many Destinations. Use each Route for destination-specific processing and delivery behavior instead of duplicating the Stream.
        </p>
      </section>

      {operationalSnapshot && streamFilter !== '__all__' ? (
        <section aria-label="Selected Stream delivery flow" className="space-y-3" data-testid="routes-flow-maps">
          {operationalSnapshot.streams.filter((stream) => String(stream.stream_id) === streamFilter).map((stream) => (
            <StreamFlowMap
              key={stream.stream_id}
              streamId={stream.stream_id}
              streamName={stream.stream_name || `Stream #${stream.stream_id}`}
              routes={consoleRows.filter((row) => row.route.stream_id === stream.stream_id && row.metrics != null).map((row) => row.metrics!)}
            />
          ))}
        </section>
      ) : null}

      <section aria-label="Route KPI summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6 xl:gap-3">
        <div className="rounded-lg border border-slate-200/70 bg-white/90 px-3 py-2 dark:border-gdc-border/90 dark:bg-gdc-card">
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Total Streams</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-50">
            {globalKpi?.totalStreams ?? 0}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">{globalKpi?.runningStreams ?? 0} running</p>
        </div>
        <div className="rounded-lg border border-slate-200/70 bg-white/90 px-3 py-2 dark:border-gdc-border/90 dark:bg-gdc-card">
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Total Routes</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-50">
            {globalKpi?.totalRoutes ?? routesRaw.length}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">{globalKpi?.enabledRoutes ?? 0} enabled</p>
        </div>
        <div className="rounded-lg border border-slate-200/70 bg-white/90 px-3 py-2 dark:border-gdc-border/90 dark:bg-gdc-card">
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Total Throughput</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-50">
            {formatOperationalEps(globalKpi?.eps1m)}
          </p>
          <div className="mt-1.5 text-violet-600 dark:text-violet-400">
            <MiniSparkline values={throughputSpark} />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200/70 bg-white/90 px-3 py-2 dark:border-gdc-border/90 dark:bg-gdc-card">
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Delivery Success Rate</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-50">
            {formatOperationalSuccessRate(deliverySuccessRate)}
          </p>
          <ThinProgress pct={deliverySuccessRate ?? 0} toneClass="bg-emerald-500" />
        </div>
        <div className="rounded-lg border border-slate-200/70 bg-white/90 px-3 py-2 dark:border-gdc-border/90 dark:bg-gdc-card">
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Error Rate</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-50">
            {formatOperationalSuccessRate(globalErrorRate)}
          </p>
          <div className="mt-1.5 text-red-500 dark:text-red-400">
            <MiniSparkline values={successSpark.map((v) => 100 - v)} />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200/70 bg-white/90 px-3 py-2 dark:border-gdc-border/90 dark:bg-gdc-card">
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Avg Latency</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-50">
            {globalKpi?.avgLatencyMs != null ? `${Math.round(globalKpi.avgLatencyMs)} ms` : '—'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">Operational snapshot · 5m window</p>
        </div>
      </section>

      <RoutesFlowTreeTable snapshot={operationalSnapshot} consoleRows={consoleRows} loading={loading} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RoutesProblemRoutesPanel consoleRows={consoleRows} />
        <RoutesDestinationMetricsPanel snapshot={operationalSnapshot} consoleRows={consoleRows} />
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <button
          type="button"
          onClick={() => setAllRoutesExpanded((v) => !v)}
          className="flex w-full items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 text-left hover:bg-slate-50/80 dark:border-gdc-border dark:hover:bg-gdc-rowHover"
          aria-expanded={allRoutesExpanded}
        >
          <div className="flex items-center gap-2">
            {allRoutesExpanded ? (
              <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-500" aria-hidden />
            )}
            <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">All Routes ({consoleRows.length})</h3>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-gdc-muted">
            {allRoutesExpanded ? 'Collapse' : 'Expand'} catalog table
          </span>
        </button>
        {allRoutesExpanded ? (
          <div className="flex min-w-0 flex-col gap-3 p-3">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search routes…"
                  className="h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/80 py-1 pl-8 pr-2 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400/30 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100 dark:focus:border-violet-500 dark:focus:ring-violet-500/25"
                  aria-label="Search routes"
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex-1">
                <SelectField
                  id="routes-filter-stream"
                  label="Stream filter"
                  value={streamFilter}
                  options={streamOptions}
                  onChange={setStreamFilter}
                />
                <SelectField
                  id="routes-filter-destination"
                  label="Destination filter"
                  value={destinationFilter}
                  options={destinationOptions.map((v) => ({
                    value: v,
                    label: v === '__all__' ? 'All Destinations' : v,
                  }))}
                  onChange={setDestinationFilter}
                />
                <SelectField
                  id="routes-filter-status"
                  label="Status filter"
                  value={statusFilter}
                  options={[
                    { value: '__all__', label: 'All Statuses' },
                    { value: 'Healthy', label: 'Healthy' },
                    { value: 'Warning', label: 'Warning' },
                    { value: 'Error', label: 'Error' },
                    { value: 'Disabled', label: 'Disabled' },
                    { value: 'Idle', label: 'Idle' },
                  ]}
                  onChange={setStatusFilter}
                />
                <SelectField
                  id="routes-filter-policy"
                  label="Failure policy filter"
                  value={policyFilter}
                  options={policyOptions.map((v) => ({
                    value: v,
                    label: v === '__all__' ? 'All Failure Policies' : formatFailurePolicy(v),
                  }))}
                  onChange={setPolicyFilter}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-2 dark:border-gdc-border">
              <button
                type="button"
                onClick={clearFilters}
                className="text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                Clear
              </button>
              <div className="relative" ref={columnsRef}>
                <button
                  type="button"
                  onClick={() => setColumnsMenuOpen((o) => !o)}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                  aria-expanded={columnsMenuOpen}
                >
                  <Columns3 className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                  Columns
                </button>
                {columnsMenuOpen ? (
                  <div
                    role="menu"
                    className="absolute right-0 z-30 mt-1 w-48 rounded-md border border-slate-200/90 bg-white py-2 text-[12px] shadow-lg dark:border-gdc-border dark:bg-gdc-card"
                  >
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-gdc-rowHover">
                      <input type="checkbox" checked={showRateLimitCol} onChange={(e) => setShowRateLimitCol(e.target.checked)} />
                      Rate Limit
                    </label>
                  </div>
                ) : null}
              </div>
            </div>

          <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div
              ref={useRouteVirtualization ? routesTableScrollRef : undefined}
              data-testid={useRouteVirtualization ? 'routes-virtual-scroll' : undefined}
              className={cn('overflow-x-auto', useRouteVirtualization && 'max-h-[480px] overflow-y-auto')}
              onScroll={useRouteVirtualization ? onRoutesTableScroll : undefined}
            >
              <table className={opTable}>
                <thead className="sticky top-0 z-20">
                  <tr className={cn(opThRow, 'shadow-sm')}>
                    <th scope="col" className={cn(opTh, 'min-w-[120px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Route
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[120px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Stream
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[180px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Destination
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[88px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Status
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[96px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Throughput (window avg)
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[104px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Success Rate
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[88px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Avg Latency
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[72px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Errors
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[96px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Last Activity
                    </th>
                    <th scope="col" className={cn(opTh, 'min-w-[140px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Failure Policy
                    </th>
                    {showRateLimitCol ? (
                      <th scope="col" className={cn(opTh, 'min-w-[100px] bg-slate-50/95 backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                        Rate Limit
                      </th>
                    ) : null}
                    <th scope="col" className={cn(opTh, 'min-w-[96px] bg-slate-50/95 text-right backdrop-blur-sm dark:bg-gdc-tableHeader')}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && consoleRows.length === 0
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <tr key={`sk-${i}`} className="border-b border-slate-100/90 dark:border-gdc-divider">
                          {Array.from({ length: showRateLimitCol ? 12 : 11 }).map((__, j) => (
                            <td key={j} className="px-2.5 py-2">
                              <div className="h-2.5 animate-pulse rounded bg-slate-200/90 dark:bg-gdc-elevated" />
                            </td>
                          ))}
                        </tr>
                      ))
                    : null}
                  {!loading && displayRows.length === 0 ? (
                    <tr className={cn(opTr, opStateRow)}>
                      <td
                        className={cn(opTd, 'py-8 text-center text-[12px] text-slate-500 dark:text-gdc-muted')}
                        colSpan={showRateLimitCol ? 12 : 11}
                      >
                        {consoleRows.length === 0 && !loadError
                          ? 'No routes configured yet.'
                          : 'No routes found for the selected filters.'}
                      </td>
                    </tr>
                  ) : null}
                  {topVirtualPad > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={showRateLimitCol ? 12 : 11} style={{ height: topVirtualPad, padding: 0, border: 0 }} />
                    </tr>
                  ) : null}
                  {displayRows.map((row) => (
                    <RoutesTableRow
                      key={row.route.id}
                      row={row}
                      selected={false}
                      showRateLimitCol={showRateLimitCol}
                      testBusyId={testBusyId}
                      moreMenuOpen={moreMenuRouteId === row.route.id}
                      moreMenuRef={moreMenuRef as RefObject<HTMLDivElement | null>}
                      onSelect={() => {}}
                      onTestRoute={onTestRoute}
                      onToggleMoreMenu={onToggleMoreMenu}
                      onCloseMoreMenu={onCloseMoreMenu}
                    />
                  ))}
                  {bottomVirtualPad > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={showRateLimitCol ? 12 : 11} style={{ height: bottomVirtualPad, padding: 0, border: 0 }} />
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-2 border-t border-slate-200/80 px-3 py-2 text-[11px] text-slate-600 dark:border-gdc-border dark:text-gdc-muted sm:flex-row sm:items-center sm:justify-between">
              <p className="tabular-nums">
                {useRouteVirtualization ? (
                  <>
                    Virtual scroll · {displayRows.length} visible · {totalFiltered} routes
                  </>
                ) : (
                  <>
                    Showing {totalFiltered === 0 ? 0 : pageOffset + 1} to {Math.min(pageOffset + pageSize, totalFiltered)} of{' '}
                    {totalFiltered} routes
                  </>
                )}
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {!useRouteVirtualization ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded border border-slate-200/90 px-2 py-1 text-[11px] font-semibold text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40 dark:border-gdc-border dark:text-slate-200 dark:enabled:hover:bg-slate-800/60"
                  >
                    Previous
                  </button>
                  {pageNumbers.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setPage(n)}
                      className={cn(
                        'min-w-[1.75rem] rounded px-2 py-1 text-[11px] font-semibold tabular-nums',
                        n === safePage
                          ? 'bg-violet-600 text-white shadow-sm'
                          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-gdc-rowHover',
                      )}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="rounded border border-slate-200/90 px-2 py-1 text-[11px] font-semibold text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40 dark:border-gdc-border dark:text-slate-200 dark:enabled:hover:bg-slate-800/60"
                  >
                    Next
                  </button>
                </div>
                ) : null}
                {!useRouteVirtualization ? (
                <label className="flex items-center gap-1.5 font-medium">
                  <span className="sr-only">Rows per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value))
                      setPage(1)
                    }}
                    className="h-8 rounded-md border border-slate-200/90 bg-white py-1 pl-2 pr-7 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                  >
                    {[8, 10, 25, 50].map((n) => (
                      <option key={n} value={n}>
                        {n} / page
                      </option>
                    ))}
                  </select>
                </label>
                ) : null}
              </div>
            </div>
          </div>
          </div>
        ) : null}
      </section>
      {toast ? (
        <div
          role="status"
          className={cn(
            'fixed bottom-4 right-4 z-[100] max-w-md rounded-lg border px-3 py-2 text-[12px] font-medium shadow-lg dark:shadow-black/40',
            toast.tone === 'ok'
              ? 'border-emerald-500/35 bg-emerald-50 text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-50'
              : 'border-red-500/35 bg-red-50 text-red-950 dark:border-red-500/30 dark:bg-red-950/50 dark:text-red-50',
          )}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}
