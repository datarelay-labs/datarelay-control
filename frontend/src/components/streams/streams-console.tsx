import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MinusCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Workflow,
  XCircle,
} from 'lucide-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { cn } from '../../lib/utils'
import {
  logsPath,
  newStreamPath,
  streamEditPath,
  streamRuntimePath,
} from '../../config/nav-paths'
import {
  fetchStreamMappingUiConfig,
} from '../../api/gdcRuntime'
import { fetchConnectorsList } from '../../api/gdcConnectors'
import { fetchStreamsListResult, GDC_AUTH_REQUIRED_MESSAGE } from '../../api/gdcStreams'
import { clearOperationalSnapshotCache, getOperationalSnapshot, type OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { destinationLabelsByStreamIdFromSnapshot } from '../../lib/streams-console-destination-labels'
import { createRefreshCycleSnapshotId } from '../../api/runtimeSnapshotSync'
import {
  enrichStreamRowFromOperationalSnapshot,
  mergeConnectorIntoRow,
  type ConnectorRowMetadata,
  mergeMappingUiIntoRow,
  streamReadToConsoleRow,
  type StreamConsoleRow,
} from '../../api/streamRows'
import { type StreamWorkflowInput } from '../../utils/streamWorkflow'
import { workflowOverridesFromMappingUi } from '../../utils/mappingUiWorkflow'
import { streamsSectionKpiFromOperationalSnapshot, type StreamsSectionKpi } from '../../api/streamsKpi'
import { groupRowsBySourceProduct } from '../../lib/source-product-group'
import {
  aggregateGroupIssueBreakdown,
  computeGroupOperationalStats,
  computeStreamsPageKpi,
  formatGroupHeaderSummary,
  formatRelativeShort,
  groupHealthLabelFromSeverity,
  groupHealthToneFromSeverity,
  type GroupHealthLabel,
} from '../../lib/stream-console-metrics'
import { formatThroughputEps } from '../../lib/observability-format'
import { operationalSeverityIcon } from '../../lib/stream-operational-status'
import { StreamsHealthOverview } from './streams-health-overview'
import { StreamConsoleDetailPanel } from './stream-console-detail-panel'
import { StreamsOperationsToolbar } from './streams-operations-toolbar'
import { StreamsConsoleControls } from './streams-console-controls'
import { StreamsFilterChips } from './streams-filter-chips'
import {
  computeStreamOperationsSummary,
  filterStreamRows,
  productGroupOptions,
  sortGroupsProblemFirst,
  sortStreamsProblemFirst,
  type StreamsQuickFilter,
} from '../../lib/streams-console-operations'
import {
  formatStreamIssuesCell,
  streamConsoleLifecycleLabel,
  streamSeverityFromCauses,
} from '../../lib/stream-console-issue-causes'
import type { StreamsMetricsWindow } from '../../constants/streamConsoleFilters'
import { parseConnectorFilterFromSearch, connectorFilterIsNumericId } from '../../constants/streamConsoleFilters'
import {
  loadStreamsAutoRefresh,
  loadStreamsTimeRange,
  persistStreamsAutoRefresh,
  persistStreamsTimeRange,
  type StreamsAutoRefreshOption,
} from '../../localPreferences'
import type { StreamRead } from '../../api/types/gdcApi'
import { readStreamsConsoleSnapshot, writeStreamsConsoleSnapshot, clearStreamsConsoleSnapshot } from './streams-console-cache'
import { RuntimeFixtureModeBanner } from '../runtime/runtime-fixture-mode-banner'
import { useMountAbortController } from '../../hooks/use-mount-abort-signal'
import { isRequestAborted } from '../../lib/request-abort'

const STREAMS_CONNECTOR_ENRICH_CONCURRENCY = 12

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const limit = Math.max(1, concurrency)
  const out: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex
      nextIndex += 1
      if (i >= items.length) return
      out[i] = await mapper(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

async function enrichStreamConsoleRows(
  streamList: StreamRead[],
  gen: number,
  loadGenRef: MutableRefObject<number>,
  isCancelled: () => boolean,
  _metricsWindow: StreamsMetricsWindow,
  _snapshotId: string | undefined,
  fetchOpts: { signal?: AbortSignal },
  setters: {
    setDisplayRows: Dispatch<SetStateAction<StreamConsoleRow[]>>
  },
): Promise<void> {
  const isCurrent = () => !isCancelled() && loadGenRef.current === gen

  const baseRows = streamList.map((s) => streamReadToConsoleRow(s))
  setters.setDisplayRows(baseRows)
  if (!isCurrent()) return

  const connectorById = new Map<number, ConnectorRowMetadata>()
  const connectorIds = [
    ...new Set(streamList.map((s) => s.connector_id).filter((x): x is number => typeof x === 'number')),
  ]

  const [connectorsList, operationalSnapshot] = await Promise.all([
    fetchConnectorsList(fetchOpts),
    getOperationalSnapshot(),
  ])
  for (const c of connectorsList ?? []) {
    if (!connectorIds.includes(c.id)) continue
    const nm = (c.name ?? '').trim()
    const pg = (c.product_group ?? '').trim() || null
    if (nm || pg) connectorById.set(c.id, { name: nm || null, product_group: pg })
  }
  if (!isCurrent()) return

  const operationalByStreamId = new Map(
    (operationalSnapshot?.streams ?? []).map((stream) => [stream.stream_id, stream]),
  )
  const snapshotProblems = operationalSnapshot?.problems ?? []

  const enrichedRows = baseRows.map((row) => {
    const sid = Number(row.id)
    if (!Number.isFinite(sid) || !/^\d+$/.test(row.id)) {
      return { ...row, runtimeStatsAttempted: true, hasRuntimeApiSnapshot: false }
    }
    const snap = operationalByStreamId.get(sid)
    if (!snap) {
      return { ...row, runtimeStatsAttempted: true, hasRuntimeApiSnapshot: false }
    }
    return enrichStreamRowFromOperationalSnapshot(row, snap, snapshotProblems)
  })
  if (!isCurrent()) return

  const withConnectors = enrichedRows.map((row) => {
    const connMeta = row.connectorId != null ? connectorById.get(row.connectorId) : undefined
    return mergeConnectorIntoRow(row, connMeta ?? null)
  })
  setters.setDisplayRows(withConnectors)
}

/** Lazy mapping-ui enrichment — deferred until group expand or flat-table visibility (P1). */
export async function enrichMappingUiForStreamIds(
  streamIds: readonly number[],
  gen: number,
  loadGenRef: MutableRefObject<number>,
  isCancelled: () => boolean,
  alreadyFetched: ReadonlySet<number>,
  fetchOpts: { signal?: AbortSignal },
  setters: {
    setDisplayRows: Dispatch<SetStateAction<StreamConsoleRow[]>>
    setWorkflowExtrasByStreamId: Dispatch<SetStateAction<Record<string, Partial<StreamWorkflowInput>>>>
  },
): Promise<number[]> {
  const pending = streamIds.filter((id) => Number.isFinite(id) && id > 0 && !alreadyFetched.has(id))
  if (!pending.length) return []

  const isCurrent = () => !isCancelled() && loadGenRef.current === gen

  const cfgPairs = await mapWithConcurrency(pending, STREAMS_CONNECTOR_ENRICH_CONCURRENCY, async (id) => {
    try {
      const cfg = await fetchStreamMappingUiConfig(id, fetchOpts)
      return [id, cfg] as const
    } catch (e) {
      if (isRequestAborted(e)) throw e
      return [id, null] as const
    }
  })
  if (!isCurrent()) return []

  const cfgById = new Map<number, NonNullable<Awaited<ReturnType<typeof fetchStreamMappingUiConfig>>>>()
  for (const [id, cfg] of cfgPairs) {
    if (cfg != null) cfgById.set(id, cfg)
  }

  const extrasPatch: Record<string, Partial<StreamWorkflowInput>> = {}
  const fetchedIds: number[] = []
  for (const id of pending) {
    const cfg = cfgById.get(id)
    if (cfg) extrasPatch[String(id)] = workflowOverridesFromMappingUi(cfg)
    fetchedIds.push(id)
  }

  if (Object.keys(extrasPatch).length > 0) {
    setters.setWorkflowExtrasByStreamId((prev) => ({ ...prev, ...extrasPatch }))
  }

  setters.setDisplayRows((prev) =>
    prev.map((row) => {
      const sid = Number(row.id)
      if (!Number.isFinite(sid) || !pending.includes(sid)) return row
      const cfg = cfgById.get(sid)
      return cfg ? mergeMappingUiIntoRow(row, cfg) : row
    }),
  )

  return fetchedIds
}


function GroupHealthBadge({
  label,
  tone,
}: {
  label: GroupHealthLabel
  tone: ReturnType<typeof groupHealthToneFromSeverity>
}) {
  const Icon =
    label === 'Healthy'
      ? CheckCircle2
      : label === 'Warning'
        ? AlertTriangle
        : label === 'Critical'
          ? XCircle
          : MinusCircle
  const toneClass =
    tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : tone === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : tone === 'error'
          ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400'
          : 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400'
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold', toneClass)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  )
}

function StreamRowActions({ row }: { row: StreamConsoleRow }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasId = /^\d+$/.test(row.id)

  const menuItemCls =
    'flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-gdc-elevated'

  return (
    <div
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Link
        to={hasId ? streamRuntimePath(row.id) : '#'}
        aria-disabled={!hasId}
        title={hasId ? 'Open Runtime' : 'Runtime unavailable: missing stream id'}
        aria-label={`Open Runtime: ${row.name}`}
        className={cn(
          'inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold shadow-sm transition-colors',
          hasId
            ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
            : 'cursor-not-allowed bg-slate-300/60 text-slate-500 dark:bg-slate-700 dark:text-slate-500',
        )}
      >
        <Play className="h-3.5 w-3.5" aria-hidden />
        Open Runtime
      </Link>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          onBlur={() => window.setTimeout(() => setMenuOpen(false), 160)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-gdc-elevated dark:hover:text-slate-300"
          aria-label="More actions"
          title="More actions"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-full z-[60] mt-1 min-w-[11rem] rounded-lg border border-slate-200/80 bg-white py-1 shadow-lg dark:border-gdc-border dark:bg-gdc-card">
            <Link to={streamRuntimePath(row.id)} onClick={() => setMenuOpen(false)} className={menuItemCls}>
              <Play className="h-3.5 w-3.5 text-violet-500" aria-hidden />
              Open Runtime
            </Link>
            <Link to={streamEditPath(row.id)} onClick={() => setMenuOpen(false)} className={menuItemCls}>
              <Pencil className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              Edit Stream
            </Link>
            <Link to={logsPath(row.id)} onClick={() => setMenuOpen(false)} className={menuItemCls}>
              <ScrollText className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              View Logs
            </Link>
            <Link
              to={`${streamEditPath(row.id)}?tab=route_processing`}
              onClick={() => setMenuOpen(false)}
              className={menuItemCls}
            >
              <Workflow className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              Route Processing
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─── StreamsConsole ───────────────────────────────────────────────────────────

function emptyStreamsKpi(): StreamsSectionKpi {
  return {
    total: 0,
    totalTrend: '—',
    running: 0,
    runningPct: '—',
    degraded: 0,
    degradedPct: '—',
    error: 0,
    errorPct: '—',
    stopped: 0,
    stoppedPct: '—',
    processedEvents: '—',
    processedEventsTrend: '—',
  }
}

const streamsGroupTableThClass =
  'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong'

const streamsGroupTableTdClass = 'px-4 py-3.5 align-middle text-sm text-slate-700 dark:text-gdc-mutedStrong'

function StreamSeverityIcon({ row, metricsWindow }: { row: StreamConsoleRow; metricsWindow: StreamsMetricsWindow }) {
  const severity = streamSeverityFromCauses(row, metricsWindow)
  const kind = operationalSeverityIcon(severity)
  if (kind === 'critical') return <XCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden />
  if (kind === 'warn') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
  if (kind === 'stopped') return <MinusCircle className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
}

function StreamOperationalStatusBadge({
  row,
  metricsWindow,
}: {
  row: StreamConsoleRow
  metricsWindow: StreamsMetricsWindow
}) {
  const severity = streamSeverityFromCauses(row, metricsWindow)
  const label = streamConsoleLifecycleLabel(row)
  const toneClass =
    severity === 'critical' || label === 'Critical'
      ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
      : severity === 'warning' || label === 'Warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : label === 'Stopped' || label === 'Disabled' || label === 'No Data'
          ? 'border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-400'
          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  return (
    <span className={cn('inline-flex items-center rounded-lg border px-2 py-0.5 text-xs font-semibold', toneClass)}>
      {label}
    </span>
  )
}

function streamRowHighlightClass(row: StreamConsoleRow, metricsWindow: StreamsMetricsWindow): string {
  const severity = streamSeverityFromCauses(row, metricsWindow)
  if (severity === 'critical') return 'bg-red-500/[0.04] dark:bg-red-500/[0.06]'
  if (severity === 'warning') return 'bg-amber-500/[0.05] dark:bg-amber-500/[0.07]'
  return 'bg-slate-50/40 dark:bg-gdc-elevated/30'
}

function childEpsLabel(row: StreamConsoleRow): string | null {
  if (!row.hasRuntimeApiSnapshot) return null
  const currentEps = row.eps5m != null && row.eps5m > 0 ? row.eps5m : row.ingestEps
  if (!Number.isFinite(currentEps) || currentEps <= 0) return null
  return `${formatThroughputEps(currentEps)} EPS`
}

export function StreamsConsole() {
  const cachedSnapshot = readStreamsConsoleSnapshot()
  const [displayRows, setDisplayRows] = useState<StreamConsoleRow[]>(() => cachedSnapshot?.displayRows ?? [])
  const [autoRefresh, setAutoRefresh] = useState<StreamsAutoRefreshOption>('Off')
  const [timeRange, setTimeRange] = useState<StreamsMetricsWindow>('1h')
  useLayoutEffect(() => {
    setAutoRefresh(loadStreamsAutoRefresh())
    setTimeRange(loadStreamsTimeRange())
  }, [])
  const [sectionKpi, setSectionKpi] = useState<StreamsSectionKpi>(
    () => cachedSnapshot?.sectionKpi ?? emptyStreamsKpi(),
  )
  const [streamsLoading, setStreamsLoading] = useState(() => (cachedSnapshot?.displayRows.length ?? 0) === 0)
  const [streamsListError, setStreamsListError] = useState<string | null>(null)
  const [streamsAuthRequired, setStreamsAuthRequired] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const [selectedGroupLabel, setSelectedGroupLabel] = useState<string | null>(() => {
    const params = new URLSearchParams(location.search)
    return params.get('expand_group')?.trim() || null
  })
  const [workflowExtrasByStreamId, setWorkflowExtrasByStreamId] = useState<
    Record<string, Partial<StreamWorkflowInput>>
  >(() => cachedSnapshot?.workflowExtrasByStreamId ?? {})
  const [refreshVersion, setRefreshVersion] = useState(0)
  const abortRef = useMountAbortController()
  const loadGenRef = useRef(0)
  const prevStreamsPathnameRef = useRef(location.pathname)
  const mappingUiFetchedRef = useRef<Set<number>>(new Set())
  const hasLoadedOnceRef = useRef((cachedSnapshot?.displayRows.length ?? 0) > 0)
  const [operationalSnapshot, setOperationalSnapshot] = useState<OperationalSnapshotResponse | null>(null)
  const [selectedStreamRow, setSelectedStreamRow] = useState<StreamConsoleRow | null>(null)
  const [panelTopOffset, setPanelTopOffset] = useState(0)
  const outerContainerRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [quickFilter, setQuickFilter] = useState<StreamsQuickFilter>('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const connectorFilter = useMemo(() => parseConnectorFilterFromSearch(location.search), [location.search])

  const connectorFilterLabel = useMemo(() => {
    if (!connectorFilter) return null
    if (connectorFilterIsNumericId(connectorFilter)) {
      const id = Number(connectorFilter)
      const match = displayRows.find((row) => row.connectorId === id)
      return match?.connectorName && !match.connectorName.startsWith('Connector #') ? match.connectorName : null
    }
    return connectorFilter
  }, [connectorFilter, displayRows])

  const clearConnectorFilter = useCallback(() => {
    const params = new URLSearchParams(location.search)
    params.delete('connector')
    const qs = params.toString()
    navigate(qs ? `/streams?${qs}` : '/streams')
  }, [location.search, navigate])
  const destinationLabelsByStreamId = useMemo(
    () => destinationLabelsByStreamIdFromSnapshot(operationalSnapshot?.routes),
    [operationalSnapshot],
  )
  const groupRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const highlightedGroupLabel = useMemo(
    () => new URLSearchParams(location.search).get('expand_group')?.trim() ?? null,
    [location.search],
  )

  useEffect(() => {
    if (displayRows.length === 0) return
    writeStreamsConsoleSnapshot({ displayRows, workflowExtrasByStreamId, sectionKpi })
  }, [displayRows, workflowExtrasByStreamId, sectionKpi])

  useEffect(() => {
    if (autoRefresh === 'Off') return
    const ms =
      autoRefresh === '15s'
        ? 15_000
        : autoRefresh === '30s'
          ? 30_000
          : autoRefresh === '1m'
            ? 60_000
            : autoRefresh === '5m'
              ? 300_000
              : 0
    if (!ms) return
    const id = window.setInterval(() => setRefreshVersion((v) => v + 1), ms)
    return () => window.clearInterval(id)
  }, [autoRefresh])

  useEffect(() => {
    const onRuntimeUpdated = () => {
      clearOperationalSnapshotCache()
      setRefreshVersion((v) => v + 1)
    }
    window.addEventListener('gdc-runtime-control-updated', onRuntimeUpdated as EventListener)
    window.addEventListener('gdc-runtime-run-once', onRuntimeUpdated as EventListener)
    return () => {
      window.removeEventListener('gdc-runtime-control-updated', onRuntimeUpdated as EventListener)
      window.removeEventListener('gdc-runtime-run-once', onRuntimeUpdated as EventListener)
    }
  }, [])

  useEffect(() => {
    const prev = prevStreamsPathnameRef.current
    prevStreamsPathnameRef.current = location.pathname
    // Refresh only when navigating back to /streams from another route — not query-only changes.
    if (location.pathname === '/streams' && prev !== '/streams') {
      setRefreshVersion((v) => v + 1)
    }
  }, [location.pathname])

  useEffect(() => {
    const gen = ++loadGenRef.current
    let cancelled = false
    const showFullScreenLoader = displayRows.length === 0
    const snapshot_id = createRefreshCycleSnapshotId()
    const heavyFetchOpts = { signal: abortRef.current?.signal }

    ;(async () => {
      if (showFullScreenLoader) setStreamsLoading(true)
      setStreamsListError(null)
      setStreamsAuthRequired(false)

      void getOperationalSnapshot()
        .then((snapshot) => {
          if (cancelled || loadGenRef.current !== gen) return
          if (snapshot != null) {
            setSectionKpi(streamsSectionKpiFromOperationalSnapshot(snapshot))
            setOperationalSnapshot(snapshot)
          }
        })
        .catch((e) => {
          if (isRequestAborted(e)) return
        })

      try {
        const listResult = await fetchStreamsListResult()
        if (cancelled || loadGenRef.current !== gen) return

        if (listResult.ok === false) {
          clearStreamsConsoleSnapshot()
          setStreamsAuthRequired(listResult.authRequired)
          setStreamsListError(listResult.message)
          setDisplayRows([])
          setWorkflowExtrasByStreamId({})
          return
        }

        const streamList = listResult.data

        if (!streamList.length) {
          setDisplayRows([])
          setWorkflowExtrasByStreamId({})
          setSectionKpi((prev) => ({
            ...prev,
            total: 0,
            totalTrend: 'Live · streams API',
          }))
          return
        }

        const quickRows = streamList.map((s) => streamReadToConsoleRow(s))
        setDisplayRows(quickRows)
        setStreamsLoading(false)
        hasLoadedOnceRef.current = true
        setSectionKpi((prev) => ({
          ...prev,
          total: streamList.length,
          totalTrend: 'Live · streams API',
        }))

        mappingUiFetchedRef.current = new Set()
        void enrichStreamConsoleRows(streamList, gen, loadGenRef, () => cancelled, timeRange, snapshot_id, heavyFetchOpts, {
          setDisplayRows,
        })
      } catch (e) {
        if (isRequestAborted(e)) return
        if (loadGenRef.current === gen) {
          setStreamsListError(e instanceof Error ? e.message : 'Failed to load streams.')
          setDisplayRows([])
          setWorkflowExtrasByStreamId({})
        }
      } finally {
        if (loadGenRef.current === gen) {
          setStreamsLoading(false)
          hasLoadedOnceRef.current = true
        }
      }
    })()

    return () => {
      cancelled = true
      loadGenRef.current += 1
    }
  }, [refreshVersion, timeRange, abortRef])

  const filteredRows = useMemo(
    () =>
      filterStreamRows({
        rows: displayRows,
        searchQuery,
        quickFilter,
        groupFilter,
        connectorFilter,
        destinationLabelsByStreamId,
      }),
    [displayRows, searchQuery, quickFilter, groupFilter, connectorFilter, destinationLabelsByStreamId],
  )

  const productGroups = useMemo(() => {
    const groups = groupRowsBySourceProduct(filteredRows)
    return sortGroupsProblemFirst(
      groups.map((group) => ({
        ...group,
        rows: sortStreamsProblemFirst(group.rows),
      })),
    )
  }, [filteredRows])

  const groupFilterOptions = useMemo(() => productGroupOptions(displayRows), [displayRows])

  const operationsSummary = useMemo(() => computeStreamOperationsSummary(displayRows), [displayRows])

  const filtersActive =
    searchQuery.trim().length > 0 || quickFilter !== 'all' || groupFilter !== 'all' || connectorFilter != null

  useEffect(() => {
    const label = new URLSearchParams(location.search).get('expand_group')?.trim()
    if (!label) return
    setSelectedGroupLabel((prev) => (prev === label ? prev : label))
  }, [location.search, productGroups.length])

  useEffect(() => {
    if (!highlightedGroupLabel || productGroups.length === 0) return
    const el = groupRowRefs.current.get(highlightedGroupLabel)
    if (el == null) return
    const timer = window.setTimeout(() => {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [highlightedGroupLabel, productGroups.length, selectedGroupLabel])

  const streamsPageKpi = useMemo(
    () => computeStreamsPageKpi(productGroups, filteredRows),
    [productGroups, filteredRows],
  )

  const toggleProductGroup = useCallback((productLabel: string) => {
    setSelectedGroupLabel((prev) => (prev === productLabel ? null : productLabel))
  }, [])

  const handleAutoRefreshChange = useCallback((value: StreamsAutoRefreshOption) => {
    setAutoRefresh(value)
    persistStreamsAutoRefresh(value)
  }, [])

  const handleTimeRangeChange = useCallback((value: StreamsMetricsWindow) => {
    setTimeRange(value)
    persistStreamsTimeRange(value)
    setRefreshVersion((v) => v + 1)
  }, [])

  const streamIdsForLazyMappingUi = useMemo(() => {
    const ids = new Set<number>()
    for (const group of productGroups) {
      if (selectedGroupLabel !== group.productLabel) continue
      for (const row of group.rows) {
        const sid = Number(row.id)
        if (Number.isFinite(sid) && sid > 0 && /^\d+$/.test(row.id)) ids.add(sid)
      }
    }
    return [...ids]
  }, [productGroups, selectedGroupLabel])

  useEffect(() => {
    if (!streamIdsForLazyMappingUi.length) return
    const gen = loadGenRef.current
    let cancelled = false
    const fetchOpts = { signal: abortRef.current?.signal }
    void enrichMappingUiForStreamIds(
      streamIdsForLazyMappingUi,
      gen,
      loadGenRef,
      () => cancelled,
      mappingUiFetchedRef.current,
      fetchOpts,
      { setDisplayRows, setWorkflowExtrasByStreamId },
    )
      .then((fetched) => {
        for (const id of fetched) mappingUiFetchedRef.current.add(id)
      })
      .catch((e) => {
        if (isRequestAborted(e)) return
      })
    return () => {
      cancelled = true
    }
  }, [streamIdsForLazyMappingUi, refreshVersion, abortRef])

  const streamsEmptyMessage = useMemo(() => {
    if (streamsAuthRequired) return GDC_AUTH_REQUIRED_MESSAGE
    if (streamsListError) return streamsListError
    if (streamsLoading) return ''
    if (displayRows.length > 0 && filteredRows.length === 0) {
      return filtersActive
        ? 'No streams match your filters.'
        : 'No stream groups found.'
    }
    return 'No streams are configured yet. Create your first stream to connect a source, map fields, and deliver to a destination.'
  }, [
    streamsAuthRequired,
    streamsListError,
    streamsLoading,
    displayRows.length,
    filteredRows.length,
    filtersActive,
  ])

  const initialLoading = streamsLoading && displayRows.length === 0

  return (
    <div ref={outerContainerRef} className="flex w-full min-w-0 items-start gap-0" data-testid="streams-console">
    <div className={cn('flex min-w-0 flex-col gap-5', selectedStreamRow ? 'flex-1' : 'w-full')}>
      {/* Toolbar only — App Shell owns the page title */}
      <div className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
          Which stream group needs attention? Expand a Source Product group to find the affected stream, then open Runtime for cause analysis.
        </p>
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <Link
            to={newStreamPath()}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500/40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New Stream
          </Link>
          <StreamsConsoleControls
            autoRefresh={autoRefresh}
            onAutoRefreshChange={handleAutoRefreshChange}
            timeRange={timeRange}
            onTimeRangeChange={handleTimeRangeChange}
            onManualRefresh={() => { clearOperationalSnapshotCache(); setRefreshVersion((v) => v + 1) }}
            refreshing={streamsLoading}
          />
        </div>
      </div>

      <RuntimeFixtureModeBanner surface="streams" />

      <StreamsHealthOverview
        kpi={streamsPageKpi}
        summary={operationsSummary}
        groupCount={productGroups.length}
        loading={initialLoading}
      />

      <StreamsOperationsToolbar
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        quickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
        groupFilter={groupFilter}
        onGroupFilterChange={setGroupFilter}
        groupOptions={groupFilterOptions}
      />

      <StreamsFilterChips
        connectorFilter={connectorFilter}
        connectorFilterLabel={connectorFilterLabel}
        onClearConnectorFilter={clearConnectorFilter}
        timeRange={timeRange}
        onClearTimeRange={() => handleTimeRangeChange('1h')}
        timeRangeIsDefault={timeRange === '1h'}
      />

      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card" data-testid="streams-product-groups">
        {initialLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500 dark:text-gdc-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading streams…
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="px-5 py-12 text-center" data-testid="streams-empty-panel">
            <p
              className={cn('text-sm', streamsAuthRequired && 'font-medium text-amber-800 dark:text-amber-200')}
              data-testid={streamsAuthRequired ? 'streams-auth-required' : 'streams-empty-state'}
            >
              {streamsEmptyMessage}
            </p>
            {!streamsAuthRequired && displayRows.length === 0 ? (
              <Link
                to={newStreamPath()}
                data-testid="streams-create-first"
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Create First Stream
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-slate-200/80 dark:border-gdc-border">
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[16rem]')}>
                      Stream group
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[7rem]')}>
                      Health
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[12rem]')}>
                      Attention
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'w-12 pr-4')}>
                      <span className="sr-only">Expand</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {productGroups.map((group) => {
                    const expanded = selectedGroupLabel === group.productLabel
                    const issues = aggregateGroupIssueBreakdown(group.rows, timeRange)
                    const groupStats = computeGroupOperationalStats(group.rows)
                    const healthLabel = groupHealthLabelFromSeverity(group.operationalSeverity)
                    const healthTone = groupHealthToneFromSeverity(group.operationalSeverity)
                    const headerSummary = formatGroupHeaderSummary(groupStats)
                    return (
                      <Fragment key={group.productLabel}>
                        <tr
                          ref={(el) => {
                            if (el) groupRowRefs.current.set(group.productLabel, el)
                            else groupRowRefs.current.delete(group.productLabel)
                          }}
                          data-testid={`stream-group-row-${group.productLabel}`}
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          onClick={() => toggleProductGroup(group.productLabel)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              toggleProductGroup(group.productLabel)
                            }
                          }}
                          className={cn(
                            'cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50/90 dark:border-gdc-border/60 dark:hover:bg-gdc-rowHover/50',
                            expanded && 'bg-slate-50/70 dark:bg-gdc-elevated/20',
                            highlightedGroupLabel === group.productLabel &&
                              'ring-2 ring-inset ring-slate-400/50 bg-slate-100/80 dark:bg-slate-500/15',
                          )}
                        >
                          <td className={streamsGroupTableTdClass}>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{group.productLabel}</p>
                              <p
                                className="mt-0.5 truncate text-xs text-slate-500 dark:text-gdc-muted"
                                data-testid={`stream-group-summary-${group.productLabel}`}
                              >
                                {headerSummary}
                              </p>
                            </div>
                          </td>
                          <td className={streamsGroupTableTdClass}>
                            <GroupHealthBadge label={healthLabel} tone={healthTone} />
                          </td>
                          <td className={cn(streamsGroupTableTdClass, 'max-w-[16rem] text-sm font-medium leading-snug')}>
                            <span
                              className={cn(
                                issues.causes.length > 0
                                  ? 'text-amber-800 dark:text-amber-200'
                                  : 'text-slate-500 dark:text-gdc-muted',
                              )}
                              data-testid={`stream-group-issues-${group.productLabel}`}
                            >
                              {issues.label}
                            </span>
                          </td>
                          <td className={cn(streamsGroupTableTdClass, 'pr-4')}>
                            {expanded ? (
                              <ChevronDown className="inline h-4 w-4 text-slate-400" aria-hidden />
                            ) : (
                              <ChevronRight className="inline h-4 w-4 text-slate-400" aria-hidden />
                            )}
                          </td>
                        </tr>
                        {expanded
                          ? group.rows.map((row) => {
                              const issueLabel = formatStreamIssuesCell(row, timeRange)
                              const severity = streamSeverityFromCauses(row, timeRange)
                              const isSelected = selectedStreamRow?.id === row.id
                              const epsMeta = childEpsLabel(row)
                              const statusBorderClass =
                                severity === 'critical'
                                  ? 'border-l-red-500'
                                  : severity === 'warning'
                                    ? 'border-l-amber-500'
                                    : row.hasRuntimeApiSnapshot
                                      ? 'border-l-emerald-500'
                                      : 'border-l-slate-400'
                              const lastEvent =
                                row.hasRuntimeApiSnapshot ? formatRelativeShort(row.lastActivityRelative) : null
                              return (
                                <tr
                                  key={row.id}
                                  data-testid={`stream-group-child-row-${row.id}`}
                                  className={cn(
                                    streamRowHighlightClass(row, timeRange),
                                    'cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-100/80 dark:border-gdc-border/40 dark:hover:bg-gdc-rowHover/70',
                                    isSelected && 'ring-2 ring-inset ring-slate-400/40 bg-slate-100/60 dark:bg-slate-500/10',
                                  )}
                                  onClick={(e) => {
                                    const tr = e.currentTarget as HTMLTableRowElement
                                    if (!isSelected && outerContainerRef.current) {
                                      const trRect = tr.getBoundingClientRect()
                                      const containerRect = outerContainerRef.current.getBoundingClientRect()
                                      const trTop = trRect.top + window.scrollY
                                      const containerTop = containerRect.top + window.scrollY
                                      setPanelTopOffset(Math.max(0, trTop - containerTop))
                                    } else {
                                      setPanelTopOffset(0)
                                    }
                                    setSelectedStreamRow(isSelected ? null : row)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      const tr = e.currentTarget as HTMLTableRowElement
                                      if (!isSelected && outerContainerRef.current) {
                                        const trRect = tr.getBoundingClientRect()
                                        const containerRect = outerContainerRef.current.getBoundingClientRect()
                                        const trTop = trRect.top + window.scrollY
                                        const containerTop = containerRect.top + window.scrollY
                                        setPanelTopOffset(Math.max(0, trTop - containerTop))
                                      } else {
                                        setPanelTopOffset(0)
                                      }
                                      setSelectedStreamRow(isSelected ? null : row)
                                    }
                                  }}
                                  role="button"
                                  tabIndex={0}
                                  aria-pressed={isSelected}
                                >
                                  <td className={cn(streamsGroupTableTdClass, 'border-l-4 pl-10', statusBorderClass)}>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <StreamSeverityIcon row={row} metricsWindow={timeRange} />
                                        {/^\d+$/.test(row.id) ? (
                                          <Link
                                            to={streamRuntimePath(row.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="truncate text-sm font-semibold text-slate-900 hover:underline dark:text-slate-100"
                                            title={`Open Runtime: ${row.name}`}
                                          >
                                            {row.name}
                                          </Link>
                                        ) : (
                                          <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{row.name}</span>
                                        )}
                                      </div>
                                      <p className="mt-0.5 truncate pl-6 text-xs text-slate-500 dark:text-gdc-muted">
                                        {[
                                          row.connectorName !== '—' ? row.connectorName : null,
                                          row.sourceTypeLabel !== '—' ? row.sourceTypeLabel : null,
                                          epsMeta,
                                          lastEvent ? `Last event ${lastEvent}` : null,
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </p>
                                    </div>
                                  </td>
                                  <td className={streamsGroupTableTdClass}>
                                    <StreamOperationalStatusBadge row={row} metricsWindow={timeRange} />
                                  </td>
                                  <td
                                    className={cn(
                                      streamsGroupTableTdClass,
                                      'max-w-[16rem] whitespace-normal text-sm font-medium leading-snug',
                                      issueLabel !== '—'
                                        ? 'text-amber-800 dark:text-amber-200'
                                        : 'text-slate-500 dark:text-gdc-muted',
                                    )}
                                    data-testid={`stream-row-issues-${row.id}`}
                                  >
                                    {issueLabel}
                                  </td>
                                  <td className={cn(streamsGroupTableTdClass, 'pr-3')}>
                                    <StreamRowActions row={row} />
                                  </td>
                                </tr>
                              )
                            })
                          : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200/80 px-4 py-2.5 text-xs text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
              {productGroups.length} group{productGroups.length === 1 ? '' : 's'} · {filteredRows.length} stream
              {filteredRows.length === 1 ? '' : 's'}
              {displayRows.length !== filteredRows.length ? ` (${displayRows.length} total)` : ''}
            </div>
          </>
        )}
      </div>

      <p className="text-xs tabular-nums text-slate-500 dark:text-gdc-muted">
        {productGroups.length} Stream Group{productGroups.length === 1 ? '' : 's'} | {filteredRows.length} Stream
        {filteredRows.length === 1 ? '' : 's'}
      </p>

    </div>

    {/* Right Detail Panel */}
    {selectedStreamRow ? (
      <StreamConsoleDetailPanel
        stream={selectedStreamRow}
        routes={operationalSnapshot?.routes ?? []}
        problems={operationalSnapshot?.problems ?? []}
        onClose={() => { setSelectedStreamRow(null); setPanelTopOffset(0) }}
        topOffset={panelTopOffset}
      />
    ) : null}
    </div>
  )
}
