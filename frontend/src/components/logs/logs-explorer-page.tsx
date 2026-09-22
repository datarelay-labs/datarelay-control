import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Filter,
  Loader2,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fetchConnectorsList } from '../../api/gdcConnectors'
import { fetchDestinationsList } from '../../api/gdcDestinations'
import { fetchRoutesList } from '../../api/gdcRoutes'
import { fetchStreamsList } from '../../api/gdcStreams'
import { fetchRuntimeLogsPage, fetchRuntimeLogsTotals, searchRuntimeDeliveryLogs } from '../../api/gdcRuntime'
import { fetchObservabilitySummary } from '../../api/observabilitySummary'
import { enrichLogExplorerRows, runtimeLogSearchItemToExplorerRow } from '../../api/logsAdapter'
import { logsOverviewCounts } from '../../api/logsOverviewAdapter'
import { createRuntimeSnapshotId, snapshotMatches } from '../../api/runtimeSnapshotSync'
import type { MetricMetaMap, ObservabilitySummaryResponse, RuntimeLogsTotalsResponse } from '../../api/types/gdcApi'
import { connectorDetailPath, destinationDetailPath, logsPath, routeEditPath, streamEditPath } from '../../config/nav-paths'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { loadLogsAutoRefresh, persistLogsAutoRefresh } from '../../localPreferences'
import { cn } from '../../lib/utils'
import { useDocumentVisible } from '../../hooks/use-document-visible'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  bucketLogsForHistogram,
  deliveryStatusPresentation,
  destinationFromRouteLabel,
  formatLatencyMs,
  deliveryOutcomeCountsFromRows,
  metricsWindowFromTimeRangeLabel,
  safeCtxInt,
  stageChipText,
} from './logs-console-helpers'
import { LogDetailDrawer } from './log-detail-drawer'
import { LogsDiagnosisOverview, type LogsDiagnosisSnapshot } from './logs-diagnosis-overview'
import { LevelBadge } from './logs-level-badge'
import { HelpTooltip } from '../ui/help-tooltip'
import { HELP_COPY } from '../ui/help-tooltip-copy'
import {
  ALL_ROUTES_LABEL,
  ALL_STREAMS_LABEL,
  LEVEL_FILTER_OPTIONS,
  PIPELINE_STAGE_FILTER_OPTIONS,
  TIME_RANGE_OPTIONS,
} from './logs-filter-constants'
import { getRequestId, pipelineStageLabel, type LogExplorerRow } from './logs-types'
import {
  rowMatchesStageFilter,
  SCHEMA_DRIFT_POLICY_LOG_DRILLDOWN_STAGES,
  stageFilterDropdownOptions,
  stageFilterDropdownLabel,
  stageFilterValueFromUrl,
} from './delivery-log-stages'
import {
  STATUS_FILTER_OPTIONS,
  resolveDeliveryLogApiFilters,
  statusUiLabelFromSearchParams,
  statusUrlParamFromUiLabel,
} from './delivery-log-status-url'

const KPI_WINDOW_LABEL = '1h'

const EMPTY_LOG_KPI = { total: 0, errors: 0, warnings: 0, info: 0, debug: 0 }

type ColumnKey =
  | 'expand'
  | 'time'
  | 'level'
  | 'stage'
  | 'status'
  | 'connector'
  | 'stream'
  | 'route'
  | 'destination'
  | 'latency'
  | 'retry'
  | 'message'

const COLUMN_LABELS: Record<ColumnKey, string> = {
  expand: '',
  time: 'Time',
  level: 'Level',
  stage: 'Stage',
  status: 'Status',
  connector: 'Connector',
  stream: 'Stream',
  route: 'Route',
  destination: 'Destination',
  latency: 'Latency',
  retry: 'Retry',
  message: 'Message',
}

type TableTab = 'all' | 'errors' | 'warnings'

const SAVED_SEARCHES_KEY = 'gdc.logs.savedSearches.v1'

type SavedSearchSnapshot = {
  id: string
  label: string
  search: string
  timeRange: string
  streamFilter: string
  routeFilter: string
  levelFilter: string
  stageFilter: string
  statusFilter: string
  statusUrl: string | null
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
  formatOption,
}: {
  id: string
  label: string
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  formatOption?: (option: string) => string
}) {
  const labelFor = formatOption ?? ((o: string) => o)
  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full min-w-[6rem] appearance-none rounded-lg border border-slate-200/90 bg-white py-1 pl-2.5 pr-8 text-sm font-medium text-slate-800 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-500/20 dark:border-gdc-inputBorder dark:bg-gdc-input dark:text-slate-100 dark:focus:border-gdc-primary/60 dark:focus:ring-gdc-primary/25"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labelFor(o)}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-gdc-muted"
        aria-hidden
      />
    </div>
  )
}

function DropdownMenu({
  label,
  items,
  icon: Icon,
  onPick,
}: {
  label: string
  items: readonly { id: string; label: string }[]
  icon?: typeof Bookmark
  onPick?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-card"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {Icon ? <Icon className="h-4 w-4 text-slate-500 dark:text-gdc-muted" aria-hidden /> : null}
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-slate-400 dark:text-gdc-muted" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 min-w-[12rem] rounded-lg border border-slate-200/90 bg-white py-1 text-sm shadow-lg dark:border-gdc-border dark:bg-gdc-elevated"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-gdc-card"
              onClick={() => {
                onPick?.(item.id)
                setOpen(false)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function formatTableTime(iso: string) {
  return iso.slice(0, 23).replace('T', ' ')
}

function TableSkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={`sk-${i}`} className={opTr}>
          <td className={cn(opTd, 'py-2')} colSpan={cols}>
            <div className="h-4 animate-pulse rounded bg-slate-200/80 dark:bg-gdc-elevated" />
          </td>
        </tr>
      ))}
    </>
  )
}

export function LogsExplorerPage() {
  const { streamId: streamSlug } = useParams<{ streamId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()

  const streamIdFromRoute = useMemo(() => {
    if (!streamSlug || !/^\d+$/.test(streamSlug)) return undefined
    return Number(streamSlug)
  }, [streamSlug])

  const routeIdFromQuery = useMemo(() => {
    const r = searchParams.get('route_id')
    return r && /^\d+$/.test(r) ? Number(r) : undefined
  }, [searchParams])

  const destinationIdFromQuery = useMemo(() => {
    const r = searchParams.get('destination_id')
    return r && /^\d+$/.test(r) ? Number(r) : undefined
  }, [searchParams])

  const runIdFromQuery = useMemo(() => {
    const r = searchParams.get('run_id')
    const t = r?.trim()
    return t && t.length >= 8 ? t : undefined
  }, [searchParams])

  const partialSuccessFromQuery = useMemo(() => {
    const r = searchParams.get('partial_success')
    if (r === 'true') return true
    if (r === 'false') return false
    return undefined
  }, [searchParams])

  /** Backend delivery_logs filters from URL (?status=failed & ?stage=route_send_failed) */
  const deliveryApiFilters = useMemo(() => resolveDeliveryLogApiFilters(searchParams), [searchParams])

  const streamIdFromQuery = useMemo(() => {
    const r = searchParams.get('stream_id')
    return r && /^\d+$/.test(r) ? Number(r) : undefined
  }, [searchParams])

  const effectiveStreamIdForApi = streamIdFromRoute ?? streamIdFromQuery

  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState<string>(TIME_RANGE_OPTIONS[1])
  const [streamFilter, setStreamFilter] = useState<string>(ALL_STREAMS_LABEL)
  const [routeFilter, setRouteFilter] = useState<string>(ALL_ROUTES_LABEL)
  const [levelFilter, setLevelFilter] = useState<string>(() => {
    const lv = searchParams.get('level') ?? searchParams.get('severity')
    if (lv && (LEVEL_FILTER_OPTIONS as readonly string[]).includes(lv)) return lv
    return LEVEL_FILTER_OPTIONS[0]
  })
  const [stageFilter, setStageFilter] = useState<string>(() => stageFilterValueFromUrl(searchParams.get('stage')))
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_FILTER_OPTIONS[0])
  const [chartGrain, setChartGrain] = useState<'Auto' | '1m' | '5m'>('Auto')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  useLayoutEffect(() => {
    setAutoRefresh(loadLogsAutoRefresh())
  }, [])
  const [liveTail, setLiveTail] = useState(false)
  const [tick, setTick] = useState(0)
  const [pulseFetch, setPulseFetch] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnsRef = useRef<HTMLDivElement | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const documentVisible = useDocumentVisible()
  const [logRows, setLogRows] = useState<LogExplorerRow[]>([])
  const [runtimeLogsError, setRuntimeLogsError] = useState(false)
  const [logsSource, setLogsSource] = useState<'idle' | 'page' | 'search' | 'empty' | 'error'>('idle')
  const [logsFetchLoading, setLogsFetchLoading] = useState(false)
  const [entityLabels, setEntityLabels] = useState<{
    streams: Map<number, string>
    routes: Map<number, string>
    destinations: Map<number, string>
    connectors: Map<number, string>
  }>(() => ({ streams: new Map(), routes: new Map(), destinations: new Map(), connectors: new Map() }))
  const [logsCursor, setLogsCursor] = useState<{ cursor_created_at: string; cursor_id: number } | null>(null)
  const [logsHasNext, setLogsHasNext] = useState(false)
  const [logsMetricMeta, setLogsMetricMeta] = useState<MetricMetaMap | undefined>(undefined)
  const [observabilitySummary, setObservabilitySummary] = useState<ObservabilitySummaryResponse | null>(null)
  const [logsTotals, setLogsTotals] = useState<RuntimeLogsTotalsResponse | null>(null)
  const [loadingMoreLogs, setLoadingMoreLogs] = useState(false)
  const [controlRefreshTick, setControlRefreshTick] = useState(0)
  const [dashboardStreamsRunning, setDashboardStreamsRunning] = useState<number | null>(null)
  const [tableTab, setTableTab] = useState<TableTab>('all')
  const logsFetchGenerationRef = useRef(0)

  const metricsWindow = useMemo(() => metricsWindowFromTimeRangeLabel(timeRange), [timeRange])
  const snapshotId = useMemo(
    () => createRuntimeSnapshotId(),
    [
      metricsWindow,
      effectiveStreamIdForApi,
      routeIdFromQuery,
      destinationIdFromQuery,
      runIdFromQuery,
      partialSuccessFromQuery,
      deliveryApiFilters.stage,
      deliveryApiFilters.status,
      controlRefreshTick,
      levelFilter,
    ],
  )

  const [visibleCols, setVisibleCols] = useState<Record<ColumnKey, boolean>>({
    expand: true,
    time: true,
    level: true,
    stage: true,
    status: true,
    connector: true,
    stream: true,
    route: true,
    destination: true,
    latency: true,
    retry: true,
    message: true,
  })

  const [savedSearchRev, setSavedSearchRev] = useState(0)
  const savedSearchItems = useMemo((): SavedSearchSnapshot[] => {
    try {
      const raw = localStorage.getItem(SAVED_SEARCHES_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as SavedSearchSnapshot[]
      return Array.isArray(parsed) && parsed.length ? parsed : []
    } catch {
      return []
    }
  }, [savedSearchRev])
  const [presetsExpanded, setPresetsExpanded] = useState(false)

  useEffect(() => {
    const focus = searchParams.get('focus')
    if (!focus) return
    if (focus === 'error') setLevelFilter('ERROR')
    if (focus === 'rate_limit') setSearch('rate limit')
    if (focus === 'mapping') setStageFilter('MAPPING')
    if (focus === 'route') setStageFilter('DELIVERY')
    if (focus === 'connection') {
      setLevelFilter('ERROR')
      setSearch('http')
    }
  }, [searchParams])

  useEffect(() => {
    setStageFilter(stageFilterValueFromUrl(searchParams.get('stage')))
  }, [searchParams])

  useEffect(() => {
    const lv = searchParams.get('level') ?? searchParams.get('severity')
    if (lv && (LEVEL_FILTER_OPTIONS as readonly string[]).includes(lv)) setLevelFilter(lv)
  }, [searchParams])

  const stageFilterOptions = useMemo(() => stageFilterDropdownOptions(stageFilter), [stageFilter])

  useEffect(() => {
    setStatusFilter(statusUiLabelFromSearchParams(searchParams))
  }, [searchParams])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [streams, routes, dests, connectors] = await Promise.all([
        fetchStreamsList(),
        fetchRoutesList(),
        fetchDestinationsList(),
        fetchConnectorsList(),
      ])
      if (cancelled) return
      const sm = new Map<number, string>()
      const rm = new Map<number, string>()
      const dm = new Map<number, string>()
      const cm = new Map<number, string>()
      for (const s of streams ?? []) {
        if (typeof s.id === 'number') sm.set(s.id, (s.name ?? '').trim() || `Stream #${s.id}`)
      }
      for (const r of routes ?? []) {
        if (typeof r.id === 'number') rm.set(r.id, (r.name ?? '').trim() || `Route #${r.id}`)
      }
      for (const d of dests ?? []) {
        if (typeof d.id === 'number') dm.set(d.id, (d.name ?? '').trim() || `Destination #${d.id}`)
      }
      for (const c of connectors ?? []) {
        if (typeof c.id === 'number') cm.set(c.id, (c.name ?? '').trim() || `Connector #${c.id}`)
      }
      setEntityLabels({ streams: sm, routes: rm, destinations: dm, connectors: cm })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!columnsRef.current?.contains(e.target as Node)) setColumnsOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pollingEnabled = documentVisible && (autoRefresh || liveTail)
  const pollMs = liveTail ? 5000 : 8000

  useEffect(() => {
    if (!pollingEnabled) return
    const id = window.setInterval(() => {
      setTick((t) => t + 1)
      setControlRefreshTick((c) => c + 1)
      setPulseFetch(true)
      window.setTimeout(() => setPulseFetch(false), 600)
    }, pollMs)
    return () => window.clearInterval(id)
  }, [pollingEnabled, pollMs])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const summary = await fetchObservabilitySummary(metricsWindow, { snapshot_id: snapshotId })
      if (cancelled || !summary?.totals || !snapshotMatches(snapshotId, summary)) return
      setDashboardStreamsRunning(summary.totals.streams_running ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [metricsWindow, snapshotId])

  useEffect(() => {
    const handler = () => setControlRefreshTick((v) => v + 1)
    window.addEventListener('gdc-runtime-control-updated', handler as EventListener)
    return () => window.removeEventListener('gdc-runtime-control-updated', handler as EventListener)
  }, [])

  useEffect(() => {
    const token = ++logsFetchGenerationRef.current
    const isCurrent = () => token === logsFetchGenerationRef.current
    let cancelled = false
    setLogsFetchLoading(true)
    setRuntimeLogsError(false)
    setLogsCursor(null)
    setLogsHasNext(false)
    setLogsTotals(null)
    const apiLevel = levelFilter !== LEVEL_FILTER_OPTIONS[0] ? levelFilter : undefined
    ;(async () => {
      try {
        const canonicalSummary = await fetchObservabilitySummary(metricsWindow, { snapshot_id: snapshotId })
        if (cancelled || !isCurrent()) return
        if (canonicalSummary == null || !snapshotMatches(snapshotId, canonicalSummary)) {
          setRuntimeLogsError(true)
          setLogsSource('error')
          return
        }
        const canonicalSnapshotId = canonicalSummary.snapshot_id
        setObservabilitySummary(canonicalSummary)
        void fetchRuntimeLogsTotals({
          stream_id: effectiveStreamIdForApi,
          route_id: routeIdFromQuery,
          destination_id: destinationIdFromQuery,
          run_id: runIdFromQuery,
          partial_success: partialSuccessFromQuery,
          stage: deliveryApiFilters.stage,
          status: deliveryApiFilters.status,
          level: apiLevel,
          window: metricsWindow,
          snapshot_id: canonicalSnapshotId,
        }).then((totalsRes) => {
          if (cancelled || !isCurrent() || totalsRes == null || !snapshotMatches(canonicalSnapshotId, totalsRes)) return
          setLogsTotals(totalsRes)
          setLogsMetricMeta((prev) => ({ ...(prev ?? {}), ...(canonicalSummary.metric_meta ?? {}), ...(totalsRes.metric_meta ?? {}) }))
        })
        const pagePromise = fetchRuntimeLogsPage({
          limit: 200,
          window: metricsWindow,
          stream_id: effectiveStreamIdForApi,
          route_id: routeIdFromQuery,
          destination_id: destinationIdFromQuery,
          run_id: runIdFromQuery,
          partial_success: partialSuccessFromQuery,
          stage: deliveryApiFilters.stage,
          status: deliveryApiFilters.status,
          level: apiLevel,
          snapshot_id: canonicalSnapshotId,
        })
        const searchPromise = searchRuntimeDeliveryLogs({
          stream_id: effectiveStreamIdForApi,
          route_id: routeIdFromQuery,
          destination_id: destinationIdFromQuery,
          run_id: runIdFromQuery,
          partial_success: partialSuccessFromQuery,
          stage: deliveryApiFilters.stage,
          status: deliveryApiFilters.status,
          level: apiLevel,
          limit: 250,
          window: metricsWindow,
          snapshot_id: canonicalSnapshotId,
        })
        const [pageRes, searchRes] = await Promise.all([pagePromise, searchPromise])
        if (cancelled || !isCurrent()) return
        if (pageRes?.items?.length) {
          if (!snapshotMatches(canonicalSnapshotId, pageRes)) return
          setLogRows(pageRes.items.map(runtimeLogSearchItemToExplorerRow))
          setLogsMetricMeta({ ...canonicalSummary.metric_meta, ...pageRes.metric_meta })
          setLogsSource('page')
          setLogsHasNext(pageRes.has_next)
          setLogsCursor(
            pageRes.next_cursor_created_at != null && pageRes.next_cursor_id != null
              ? { cursor_created_at: pageRes.next_cursor_created_at, cursor_id: pageRes.next_cursor_id }
              : null,
          )
          return
        }

        if (searchRes === null) {
          setRuntimeLogsError(true)
          setLogsSource('error')
          return
        }
        if (!snapshotMatches(canonicalSnapshotId, searchRes)) return
        if (searchRes.logs.length > 0) {
          setLogRows(searchRes.logs.map(runtimeLogSearchItemToExplorerRow))
          setLogsMetricMeta({ ...canonicalSummary.metric_meta, ...searchRes.metric_meta })
          setLogsSource('search')
        } else {
          setLogRows([])
          setLogsMetricMeta({ ...canonicalSummary.metric_meta, ...searchRes.metric_meta })
          setLogsSource('empty')
        }
      } finally {
        if (!cancelled && isCurrent()) setLogsFetchLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    effectiveStreamIdForApi,
    routeIdFromQuery,
    destinationIdFromQuery,
    runIdFromQuery,
    partialSuccessFromQuery,
    deliveryApiFilters.stage,
    deliveryApiFilters.status,
    controlRefreshTick,
    metricsWindow,
    snapshotId,
    levelFilter,
  ])

  const loadMoreLogsPage = useCallback(async () => {
    if (logsSource !== 'page' || !logsHasNext || !logsCursor || loadingMoreLogs) return false
    setLoadingMoreLogs(true)
    const res = await fetchRuntimeLogsPage({
      limit: 100,
      window: metricsWindow,
      stream_id: effectiveStreamIdForApi,
      route_id: routeIdFromQuery,
      destination_id: destinationIdFromQuery,
      run_id: runIdFromQuery,
      partial_success: partialSuccessFromQuery,
      stage: deliveryApiFilters.stage,
      status: deliveryApiFilters.status,
      cursor_created_at: logsCursor.cursor_created_at,
      cursor_id: logsCursor.cursor_id,
      snapshot_id: snapshotId,
    })
    setLoadingMoreLogs(false)
    if (res != null && !snapshotMatches(snapshotId, res)) return false
    if (!res?.items?.length) {
      setLogsHasNext(false)
      return false
    }
    setLogRows((prev) => [...prev, ...res.items.map(runtimeLogSearchItemToExplorerRow)])
    setLogsHasNext(res.has_next)
    setLogsCursor(
      res.next_cursor_created_at != null && res.next_cursor_id != null
        ? { cursor_created_at: res.next_cursor_created_at, cursor_id: res.next_cursor_id }
        : null,
    )
    return true
  }, [
    logsSource,
    logsHasNext,
    logsCursor,
    loadingMoreLogs,
    effectiveStreamIdForApi,
    routeIdFromQuery,
    destinationIdFromQuery,
    runIdFromQuery,
    partialSuccessFromQuery,
    deliveryApiFilters.stage,
    deliveryApiFilters.status,
    metricsWindow,
    snapshotId,
  ])

  const streamFilterOptions = useMemo(() => {
    const names = [...entityLabels.streams.values()].sort((a, b) => a.localeCompare(b))
    return [ALL_STREAMS_LABEL, ...names] as const
  }, [entityLabels.streams])

  const routeFilterOptions = useMemo(() => {
    const names = [...entityLabels.routes.values()].sort((a, b) => a.localeCompare(b))
    return [ALL_ROUTES_LABEL, ...names] as const
  }, [entityLabels.routes])

  const streamFilterId = useMemo(() => {
    if (streamFilter === ALL_STREAMS_LABEL) return null
    for (const [id, name] of entityLabels.streams) {
      if (name === streamFilter) return id
    }
    return null
  }, [streamFilter, entityLabels.streams])

  const routeFilterId = useMemo(() => {
    if (routeFilter === ALL_ROUTES_LABEL) return null
    for (const [id, name] of entityLabels.routes) {
      if (name === routeFilter) return id
    }
    return null
  }, [routeFilter, entityLabels.routes])

  useEffect(() => {
    if (effectiveStreamIdForApi == null) return
    const name = entityLabels.streams.get(effectiveStreamIdForApi)
    if (name) setStreamFilter(name)
  }, [effectiveStreamIdForApi, entityLabels.streams])

  const baseLogRows = useMemo(
    () => enrichLogExplorerRows(logRows, entityLabels),
    [logRows, entityLabels],
  )

  const logsKpiFromApi = useMemo(() => {
    if (baseLogRows.length === 0) return null
    return logsOverviewCounts(baseLogRows)
  }, [baseLogRows])

  const filteredRowsBase = useMemo(() => {
    void tick
    const q = search.trim().toLowerCase()
    return baseLogRows.filter((row) => {
      const stageLab = pipelineStageLabel(row)
      const rid = getRequestId(row)
      const hay = `${row.message} ${row.stream} ${row.connector} ${row.route} ${rid} ${row.level} ${stageLab}`.toLowerCase()
      if (q && !hay.includes(q)) return false
      if (routeIdFromQuery != null) {
        const crid = typeof row.contextJson.route_id === 'number' ? row.contextJson.route_id : null
        if (crid !== routeIdFromQuery) return false
      }
      if (destinationIdFromQuery != null) {
        const did = typeof row.contextJson.destination_id === 'number' ? row.contextJson.destination_id : null
        if (did !== destinationIdFromQuery) return false
      }
      if (runIdFromQuery != null) {
        const rid = typeof row.contextJson.run_id === 'string' ? row.contextJson.run_id : null
        if (rid !== runIdFromQuery) return false
      }
      if (streamIdFromQuery != null && streamIdFromRoute == null) {
        const sid = typeof row.contextJson.stream_id === 'number' ? row.contextJson.stream_id : null
        if (sid !== streamIdFromQuery) return false
      }
      if (streamFilterId != null) {
        const sid = typeof row.contextJson.stream_id === 'number' ? row.contextJson.stream_id : null
        if (sid !== streamFilterId) return false
      }
      if (routeFilterId != null) {
        const crid = typeof row.contextJson.route_id === 'number' ? row.contextJson.route_id : null
        if (crid !== routeFilterId) return false
      }
      if (levelFilter !== 'All Levels' && row.level !== levelFilter) return false
      if (!rowMatchesStageFilter(row, stageFilter, deliveryApiFilters.stage)) return false
      return true
    })
  }, [
    search,
    streamFilterId,
    routeFilterId,
    levelFilter,
    stageFilter,
    tick,
    baseLogRows,
    deliveryApiFilters.stage,
    routeIdFromQuery,
    destinationIdFromQuery,
    runIdFromQuery,
    streamIdFromQuery,
    streamIdFromRoute,
  ])

  const filteredRows = useMemo(() => {
    if (tableTab === 'errors') return filteredRowsBase.filter((r) => r.level === 'ERROR')
    if (tableTab === 'warnings') return filteredRowsBase.filter((r) => r.level === 'WARN')
    return filteredRowsBase
  }, [filteredRowsBase, tableTab])

  const histogramData = useMemo(() => {
    if (filteredRowsBase.length === 0) return [{ bucket: '—', error: 0, warn: 0, info: 0 }]
    return bucketLogsForHistogram(filteredRowsBase, 14)
  }, [filteredRowsBase])

  useEffect(() => {
    setPage(1)
  }, [search, timeRange, streamFilter, routeFilter, levelFilter, stageFilter, tableTab])

  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedId(null)
      return
    }
    setSelectedId((prev) => {
      if (prev == null) return null
      if (filteredRows.some((r) => r.id === prev)) return prev
      return filteredRows[0]?.id ?? null
    })
  }, [filteredRows])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const offset = (safePage - 1) * pageSize
  const pageRows = filteredRows.slice(offset, offset + pageSize)

  useEffect(() => {
    if (safePage !== page) setPage(safePage)
  }, [safePage, page])

  const selected = useMemo(
    () =>
      selectedId ? filteredRows.find((r) => r.id === selectedId) ?? baseLogRows.find((r) => r.id === selectedId) : null,
    [selectedId, filteredRows, baseLogRows],
  )

  const pageNumbers = useMemo(() => {
    const windowSize = 5
    const start = Math.max(1, Math.min(safePage - 2, totalPages - windowSize + 1))
    return Array.from({ length: Math.min(windowSize, totalPages) }, (_, i) => start + i).filter((n) => n <= totalPages)
  }, [safePage, totalPages])

  const showingFrom = filteredRows.length === 0 ? 0 : offset + 1
  const showingTo = filteredRows.length === 0 ? 0 : Math.min(offset + pageSize, filteredRows.length)

  function toggleCol(key: ColumnKey) {
    if (key === 'expand') return
    setVisibleCols((v) => ({ ...v, [key]: !v[key] }))
  }

  const visibleColCount = Object.values(visibleCols).filter(Boolean).length

  const canServerPageMore = logsSource === 'page' && logsHasNext && logsCursor != null
  const nextPageDisabled = loadingMoreLogs || (safePage >= totalPages && !canServerPageMore)

  const urlHasOperationalFilters = useMemo(
    () =>
      Boolean(
        (searchParams.get('route_id')?.trim() ?? '') !== '' ||
          (searchParams.get('stream_id')?.trim() ?? '') !== '' ||
          (searchParams.get('destination_id')?.trim() ?? '') !== '' ||
          (searchParams.get('run_id')?.trim() ?? '') !== '' ||
          (searchParams.get('status')?.trim() ?? '') !== '' ||
          (searchParams.get('stage')?.trim() ?? '') !== '' ||
          (searchParams.get('level')?.trim() ?? '') !== '' ||
          (searchParams.get('severity')?.trim() ?? '') !== '',
      ),
    [searchParams],
  )

  const removeSearchParamKey = useCallback(
    (key: string) => {
      const next = new URLSearchParams(searchParams)
      if (key === 'level' || key === 'severity') {
        next.delete('level')
        next.delete('severity')
      } else {
        next.delete(key)
      }
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const clearOperationalUrlFilters = useCallback(() => {
    navigate({ pathname: location.pathname, search: '' }, { replace: true })
    setLevelFilter(LEVEL_FILTER_OPTIONS[0])
    setStageFilter(PIPELINE_STAGE_FILTER_OPTIONS[0])
    setStatusFilter(STATUS_FILTER_OPTIONS[0])
    setSearch('')
    setStreamFilter(ALL_STREAMS_LABEL)
    setRouteFilter(ALL_ROUTES_LABEL)
  }, [navigate, location.pathname])

  const summaryStreamLabel = useMemo(() => {
    const sid = effectiveStreamIdForApi
    if (sid == null) return null
    return entityLabels.streams.get(sid) ?? `Stream #${sid}`
  }, [effectiveStreamIdForApi, entityLabels.streams])

  const summaryRouteLabel = useMemo(() => {
    if (routeIdFromQuery == null) return null
    return entityLabels.routes.get(routeIdFromQuery) ?? `Route #${routeIdFromQuery}`
  }, [routeIdFromQuery, entityLabels.routes])

  const summaryDestinationLabel = useMemo(() => {
    if (destinationIdFromQuery == null) return null
    return entityLabels.destinations.get(destinationIdFromQuery) ?? `Destination #${destinationIdFromQuery}`
  }, [destinationIdFromQuery, entityLabels.destinations])

  const severitySummaryLabel = useMemo(() => {
    const fromUrl = searchParams.get('level') ?? searchParams.get('severity')
    if (fromUrl) return fromUrl
    if (levelFilter !== LEVEL_FILTER_OPTIONS[0]) return levelFilter
    return null
  }, [searchParams, levelFilter])

  const statusSummaryLabel = useMemo(() => {
    const raw = searchParams.get('status')?.trim()
    if (raw) return raw
    return null
  }, [searchParams])

  const kpi = logsKpiFromApi ?? EMPTY_LOG_KPI
  const deliveryOutcomes = useMemo(() => deliveryOutcomeCountsFromRows(baseLogRows), [baseLogRows])
  const globalDeliveryOutcomes =
    observabilitySummary != null
      ? observabilitySummary.totals.delivery_success_events +
        observabilitySummary.totals.delivery_failed_events +
        observabilitySummary.totals.retry_success_events +
        observabilitySummary.totals.retry_failed_events
      : null

  const errorCount = logsKpiFromApi?.errors ?? 0
  const warnCount = logsKpiFromApi?.warnings ?? 0
  const infoCount = logsKpiFromApi?.info ?? 0

  const diagnosisSnapshot = useMemo((): LogsDiagnosisSnapshot => {
    return {
      loadedFailedDeliveries: deliveryOutcomes.deliveryFailed,
      loadedSuccessfulDeliveries: deliveryOutcomes.deliverySuccess,
      errorRows: errorCount,
      warningRows: warnCount,
      loadedRows: kpi.total,
      globalFailed: observabilitySummary?.totals.delivery_failed_events ?? null,
      globalSuccess: observabilitySummary?.totals.delivery_success_events ?? null,
      lifecycleRows: observabilitySummary?.totals.lifecycle_rows ?? deliveryOutcomes.lifecycleInfo,
      windowLabel: KPI_WINDOW_LABEL,
    }
  }, [deliveryOutcomes, errorCount, warnCount, kpi.total, observabilitySummary])

  function exportJson() {
    const blob = new Blob([JSON.stringify(filteredRowsBase, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gdc-logs-export-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function saveCurrentSearch() {
    const statusUrl = statusUrlParamFromUiLabel(statusFilter)
    const label = `${streamFilter} · ${levelFilter} · ${statusFilter}${search ? ` · ${search.slice(0, 32)}` : ''}`
    const snapshot: SavedSearchSnapshot = {
      id: `custom-${Date.now()}`,
      label: label || 'Saved view',
      search,
      timeRange,
      streamFilter,
      routeFilter,
      levelFilter,
      stageFilter,
      statusFilter,
      statusUrl,
    }
    try {
      const raw = localStorage.getItem(SAVED_SEARCHES_KEY)
      const cur = raw ? (JSON.parse(raw) as SavedSearchSnapshot[]) : []
      const next = [snapshot, ...cur].slice(0, 12)
      localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(next))
      setSavedSearchRev((v) => v + 1)
    } catch {
      /* ignore */
    }
  }

  function applySavedSearch(id: string) {
    const item = savedSearchItems.find((s) => s.id === id)
    if (!item) return
    setSearch(item.search ?? '')
    if (item.timeRange) setTimeRange(item.timeRange)
    if (item.streamFilter) setStreamFilter(item.streamFilter)
    if (item.routeFilter) setRouteFilter(item.routeFilter)
    if (item.levelFilter) setLevelFilter(item.levelFilter)
    if (item.stageFilter) setStageFilter(item.stageFilter)
    if (item.statusFilter) setStatusFilter(item.statusFilter)
    const next = new URLSearchParams(searchParams)
    if (item.statusUrl) next.set('status', item.statusUrl)
    else next.delete('status')
    if (item.levelFilter && item.levelFilter !== 'All Levels') next.set('level', item.levelFilter)
    else {
      next.delete('level')
      next.delete('severity')
    }
    setSearchParams(next, { replace: true })
    runManualRefresh()
  }

  function runManualRefresh() {
    setControlRefreshTick((v) => v + 1)
    setPulseFetch(true)
    window.setTimeout(() => setPulseFetch(false), 500)
  }

  const tabErrorCount = filteredRowsBase.filter((r) => r.level === 'ERROR').length
  const tabWarnCount = filteredRowsBase.filter((r) => r.level === 'WARN').length

  const errorFingerprints = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of filteredRowsBase) {
      if (r.level !== 'ERROR') continue
      const code = typeof r.contextJson.error_code === 'string' && r.contextJson.error_code.trim() !== '' ? r.contextJson.error_code.trim() : '(no code)'
      const stage = pipelineStageLabel(r)
      const key = `${code} · ${stage}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [filteredRowsBase])

  const applyLogsQuickFilter = useCallback(
    (
      preset:
        | 'errors'
        | 'delivery_fail'
        | 'rate_limit_dest'
        | 'rate_limit_src'
        | 'retry'
        | 'schema_drift_policy'
        | 'auto_protect_applied'
        | 'schema_drift_review'
        | 'path_resolution_failed'
        | 'clear',
    ) => {
      const next = new URLSearchParams(searchParams)
      if (preset === 'clear') {
        next.delete('stage')
        next.delete('status')
        next.delete('level')
        next.delete('severity')
        setLevelFilter('All Levels')
        setStageFilter('All Stages')
        setStatusFilter(STATUS_FILTER_OPTIONS[0])
        setSearchParams(next, { replace: true })
        return
      }
      const schemaDriftStageByPreset: Partial<
        Record<
          'schema_drift_policy' | 'auto_protect_applied' | 'schema_drift_review' | 'path_resolution_failed',
          string
        >
      > = {
        schema_drift_policy: SCHEMA_DRIFT_POLICY_LOG_DRILLDOWN_STAGES.policy,
        auto_protect_applied: SCHEMA_DRIFT_POLICY_LOG_DRILLDOWN_STAGES.autoProtectApplied,
        schema_drift_review: SCHEMA_DRIFT_POLICY_LOG_DRILLDOWN_STAGES.reviewRequired,
        path_resolution_failed: SCHEMA_DRIFT_POLICY_LOG_DRILLDOWN_STAGES.pathResolutionFailed,
      }
      const schemaStage = schemaDriftStageByPreset[preset as keyof typeof schemaDriftStageByPreset]
      if (schemaStage) {
        next.set('stage', schemaStage)
        next.delete('status')
        next.delete('level')
        next.delete('severity')
        setLevelFilter('All Levels')
        setStatusFilter(STATUS_FILTER_OPTIONS[0])
        setStageFilter(schemaStage)
        setSearchParams(next, { replace: true })
        setControlRefreshTick((v) => v + 1)
        return
      }
      if (preset === 'errors') {
        next.set('level', 'ERROR')
        next.delete('severity')
        next.delete('stage')
        setLevelFilter('ERROR')
      }
      if (preset === 'delivery_fail') {
        next.set('stage', 'route_send_failed')
        next.delete('status')
        next.delete('level')
        next.delete('severity')
        setLevelFilter('All Levels')
        setStatusFilter(STATUS_FILTER_OPTIONS[0])
      }
      if (preset === 'rate_limit_dest') {
        next.set('stage', 'destination_rate_limited')
        next.delete('status')
        next.delete('level')
        next.delete('severity')
        setLevelFilter('All Levels')
        setStatusFilter(STATUS_FILTER_OPTIONS[0])
      }
      if (preset === 'rate_limit_src') {
        next.set('stage', 'source_rate_limited')
        next.delete('status')
        next.delete('level')
        next.delete('severity')
        setLevelFilter('All Levels')
        setStatusFilter(STATUS_FILTER_OPTIONS[0])
      }
      if (preset === 'retry') {
        next.set('status', 'retry')
        next.delete('stage')
        next.delete('level')
        next.delete('severity')
        setLevelFilter('All Levels')
        setStatusFilter('Retry outcomes')
      }
      setSearchParams(next, { replace: true })
      setControlRefreshTick((v) => v + 1)
    },
    [searchParams, setSearchParams],
  )

  return (
    <div className="relative flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="logs-explorer-page">
      {/* Toolbar — App Shell owns the page title */}
      <div className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            What failed, and how do I recover? Scan delivery posture, open a log for diagnosis evidence, then replay or drill into Runtime without leaving the workspace.
          </p>
          {dashboardStreamsRunning != null ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-100">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {dashboardStreamsRunning} streams active
            </span>
          ) : null}
          {runtimeLogsError ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100"
              data-testid="logs-api-error"
              role="alert"
            >
              <span>Runtime logs API unavailable — diagnosis evidence stays empty until the API responds.</span>
              <button
                type="button"
                className="font-semibold text-slate-900 underline dark:text-slate-100"
                onClick={runManualRefresh}
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <DropdownMenu
            label={savedSearchItems.length ? `Saved (${savedSearchItems.length})` : 'Saved searches'}
            icon={Bookmark}
            items={[
              ...savedSearchItems.map((s) => ({ id: s.id, label: s.label })),
              { id: '__save', label: '+ Save current view' },
            ]}
            onPick={(id) => {
              if (id === '__save') saveCurrentSearch()
              else applySavedSearch(id)
            }}
          />
          <DropdownMenu
            label="Export"
            icon={Download}
            items={[
              { id: 'json', label: 'Download JSON (current filters)' },
              { id: 'csv', label: 'Download CSV (placeholder)' },
            ]}
            onPick={(id) => {
              if (id === 'json') exportJson()
            }}
          />
          <button
            type="button"
            role="switch"
            aria-checked={liveTail}
            data-testid="logs-live-tail"
            onClick={() => setLiveTail((v) => !v)}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold shadow-sm transition-colors',
              liveTail
                ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200 dark:hover:bg-gdc-card',
            )}
          >
            <Zap className={cn('h-4 w-4', liveTail ? 'text-white dark:text-slate-900' : 'text-slate-400 dark:text-gdc-muted')} aria-hidden />
            Live Tail
          </button>
        </div>
      </div>

      <LogsDiagnosisOverview snapshot={diagnosisSnapshot} loading={logsFetchLoading && logRows.length === 0} />

      {(urlHasOperationalFilters || logsFetchLoading) && (
        <section
          aria-label="Active URL filters"
          className="mx-1 mb-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
        >
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Active filters
              </span>
              {logsFetchLoading ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-gdc-border dark:bg-gdc-input dark:text-gdc-muted">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Loading…
                </span>
              ) : null}
              {searchParams.get('stream_id') ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  Stream · {summaryStreamLabel ?? `Stream #${searchParams.get('stream_id')}`}
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove stream filter"
                    onClick={() => removeSearchParamKey('stream_id')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
              {searchParams.get('route_id') ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  Route · {summaryRouteLabel ?? `Route #${searchParams.get('route_id')}`}
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove route filter"
                    onClick={() => removeSearchParamKey('route_id')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
              {searchParams.get('destination_id') ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  Destination · {summaryDestinationLabel ?? `Destination #${searchParams.get('destination_id')}`}
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove destination filter"
                    onClick={() => removeSearchParamKey('destination_id')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
              {searchParams.get('run_id') ? (
                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  <span className="min-w-0 truncate font-mono" title={searchParams.get('run_id') ?? ''}>
                    Run · {searchParams.get('run_id')}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove run filter"
                    onClick={() => removeSearchParamKey('run_id')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
              {(searchParams.get('level') ?? searchParams.get('severity')) ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  Severity · {searchParams.get('level') ?? searchParams.get('severity')}
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove severity filter"
                    onClick={() => removeSearchParamKey('severity')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
              {searchParams.get('status') ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  Status · {searchParams.get('status')}
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove status filter"
                    onClick={() => removeSearchParamKey('status')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
              {searchParams.get('stage') ? (
                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-100">
                  <span className="min-w-0 truncate font-mono" title={searchParams.get('stage') ?? ''}>
                    Stage · {searchParams.get('stage')}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded-full p-0.5 text-slate-500 hover:bg-slate-200/80 dark:text-gdc-muted dark:hover:bg-gdc-card"
                    aria-label="Remove stage filter"
                    onClick={() => removeSearchParamKey('stage')}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
            {urlHasOperationalFilters ? (
              <button
                type="button"
                onClick={clearOperationalUrlFilters}
                className="inline-flex h-8 shrink-0 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-card"
              >
                Clear Filters
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-600 dark:border-gdc-border dark:text-gdc-muted">
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Matching logs:</span>{' '}
              {logsFetchLoading ? '…' : filteredRowsBase.length.toLocaleString()}
            </span>
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Stream:</span> {summaryStreamLabel ?? '—'}
            </span>
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Route:</span> {summaryRouteLabel ?? '—'}
            </span>
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Destination:</span> {summaryDestinationLabel ?? '—'}
            </span>
            <span className="min-w-0 max-w-full">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Run:</span>{' '}
              <span className="break-all font-mono text-[10px]">{runIdFromQuery ?? '—'}</span>
            </span>
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Severity:</span> {severitySummaryLabel ?? '—'}
            </span>
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Delivery status:</span> {statusSummaryLabel ?? '—'}
            </span>
            <span className="min-w-0 max-w-full truncate font-mono text-[10px]">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Stage:</span>{' '}
              {deliveryApiFilters.stage ?? searchParams.get('stage') ?? '—'}
            </span>
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Time window:</span> {timeRange}
            </span>
          </div>
        </section>
      )}

      <div
        className="sticky top-0 z-30 -mx-1 rounded-xl border border-slate-200/80 bg-white/95 px-3 py-3 shadow-sm backdrop-blur-md supports-[backdrop-filter]:bg-white/85 dark:border-gdc-border dark:bg-gdc-panel/90 dark:supports-[backdrop-filter]:bg-gdc-panel/85"
        data-testid="logs-filter-toolbar"
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Find delivery evidence</span>
          <span className="text-xs text-slate-500 dark:text-gdc-muted">
            Filters sync with the URL; presets apply common operational views.
          </span>
        </div>
        <div className="flex flex-col gap-2 xl:flex-row xl:flex-wrap xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div className="flex min-w-[140px] flex-1 items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2 shadow-sm dark:border-gdc-inputBorder dark:bg-gdc-input">
              <Clock className="h-4 w-4 shrink-0 text-slate-400 dark:text-gdc-muted" aria-hidden />
              <SelectField id="logs-time-range" label="Time range" value={timeRange} options={TIME_RANGE_OPTIONS} onChange={setTimeRange} />
            </div>
            <SelectField id="logs-level" label="Level" value={levelFilter} options={LEVEL_FILTER_OPTIONS} onChange={setLevelFilter} />
            <SelectField id="logs-stream" label="Stream" value={streamFilter} options={streamFilterOptions} onChange={setStreamFilter} />
            <SelectField id="logs-route" label="Route" value={routeFilter} options={routeFilterOptions} onChange={setRouteFilter} />
            <SelectField
              id="logs-stage"
              label="Pipeline stage"
              value={stageFilter}
              options={stageFilterOptions}
              formatOption={stageFilterDropdownLabel}
              onChange={setStageFilter}
            />
            <SelectField
              id="logs-delivery-status"
              label="Delivery status"
              value={statusFilter}
              options={[...STATUS_FILTER_OPTIONS]}
              onChange={(label) => {
                setStatusFilter(label)
                const next = new URLSearchParams(searchParams)
                const param = statusUrlParamFromUiLabel(label)
                if (param == null) next.delete('status')
                else next.set('status', param)
                setSearchParams(next, { replace: true })
              }}
            />
            <div className="relative min-w-0 flex-[2]">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-gdc-muted"
                aria-hidden
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search message, error, request id…"
                data-testid="logs-search"
                className={cn(
                  gdcUi.input,
                  'h-9 w-full rounded-lg py-1 pl-9 pr-3 text-sm shadow-sm focus:ring-2 focus:ring-slate-500/20 dark:focus:ring-gdc-primary/25',
                )}
                aria-label="Search logs"
              />
            </div>
            <button
              type="button"
              onClick={runManualRefresh}
              data-testid="logs-search-submit"
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              <Search className="h-4 w-4" />
              Search
            </button>
          </div>
          <div
            className="flex min-w-full flex-basis-full flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 dark:border-gdc-border"
            aria-label="Quick log filters"
            data-testid="logs-presets"
          >
            <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              <Zap className="h-3 w-3 text-amber-500" aria-hidden />
              Presets
            </span>
            <button
              type="button"
              className="rounded-full border border-red-200/80 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-900 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-100"
              onClick={() => applyLogsQuickFilter('errors')}
            >
              Errors
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
              onClick={() => applyLogsQuickFilter('delivery_fail')}
            >
              Route send failed
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
              onClick={() => applyLogsQuickFilter('retry')}
            >
              Retry outcomes
            </button>
            <button
              type="button"
              className="rounded-full border border-amber-200/80 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-100 dark:border-amber-900/45 dark:bg-amber-950/35 dark:text-amber-100"
              onClick={() => applyLogsQuickFilter('rate_limit_dest')}
            >
              Dest. rate limit
            </button>
            {presetsExpanded ? (
              <>
                <button
                  type="button"
                  className="rounded-full border border-amber-200/80 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-100 dark:border-amber-900/45 dark:bg-amber-950/35 dark:text-amber-100"
                  onClick={() => applyLogsQuickFilter('rate_limit_src')}
                >
                  Source rate limit
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
                  onClick={() => applyLogsQuickFilter('schema_drift_policy')}
                >
                  Schema Drift Policy
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
                  onClick={() => applyLogsQuickFilter('auto_protect_applied')}
                >
                  Auto Protect Applied
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
                  onClick={() => applyLogsQuickFilter('schema_drift_review')}
                >
                  Schema Drift Review Required
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
                  onClick={() => applyLogsQuickFilter('path_resolution_failed')}
                >
                  Path Resolution Failed
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-gdc-border dark:text-gdc-muted dark:hover:bg-gdc-card"
              data-testid="logs-presets-more"
              onClick={() => setPresetsExpanded((v) => !v)}
            >
              {presetsExpanded ? 'Fewer presets' : 'More presets'}
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:border-gdc-border dark:text-gdc-muted dark:hover:bg-gdc-card"
              onClick={() => applyLogsQuickFilter('clear')}
            >
              Clear URL filters
            </button>
          </div>
        </div>
      </div>

      <section
        aria-label={`Logs over time (${KPI_WINDOW_LABEL})`}
        className="rounded-xl border border-slate-200/70 bg-white px-4 py-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
        data-testid="logs-histogram-panel"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Logs over time</p>
            <p className="mt-0.5 text-sm text-slate-600 dark:text-gdc-muted">
              Loaded sample mix · ERROR {errorCount.toLocaleString()} · WARN {warnCount.toLocaleString()} · INFO{' '}
              {infoCount.toLocaleString()}
              {logsTotals?.total_rows != null
                ? ` · Window telemetry ${logsTotals.total_rows.toLocaleString()}`
                : globalDeliveryOutcomes != null
                  ? ` · Full-window outcomes ${globalDeliveryOutcomes.toLocaleString()}`
                  : ''}
              {logsMetricMeta && Object.keys(logsMetricMeta).length > 0 ? ' · metric contract attached' : ''}
            </p>
          </div>
          <select
            value={chartGrain}
            onChange={(e) => setChartGrain(e.target.value as 'Auto' | '1m' | '5m')}
            className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800 dark:border-gdc-inputBorder dark:bg-gdc-input dark:text-slate-100"
            aria-label="Chart interval"
          >
            <option value="Auto">Auto</option>
            <option value="1m">1m</option>
            <option value="5m">5m</option>
          </select>
        </div>
        <div className={cn('mt-2 h-[88px] w-full transition-opacity duration-300', pulseFetch && 'opacity-70')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={histogramData} margin={{ top: 2, right: 4, left: -28, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200/80 dark:stroke-slate-600/50" vertical={false} />
              <XAxis dataKey="bucket" hide />
              <YAxis hide domain={[0, 'dataMax + 2']} />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid rgb(51 65 85)',
                  backgroundColor: 'rgb(15 23 42)',
                  color: 'rgb(241 245 249)',
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) => [`${v}`, name]}
              />
              <Bar dataKey="info" stackId="a" fill="#3b82f6" maxBarSize={10} />
              <Bar dataKey="warn" stackId="a" fill="#f59e0b" maxBarSize={10} />
              <Bar dataKey="error" stackId="a" fill="#ef4444" radius={[2, 2, 0, 0]} maxBarSize={10} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {errorFingerprints.length > 0 && baseLogRows.length > 0 ? (
        <section
          aria-label="Error fingerprints"
          className="mx-1 mt-3 rounded-xl border border-red-200/60 bg-red-50/[0.35] px-3 py-2.5 dark:border-red-900/40 dark:bg-red-950/25"
        >
          <p className="text-[10px] font-bold uppercase tracking-wide text-red-900 dark:text-red-200/90">
            Error fingerprints (code + stage)
          </p>
          <p className="mt-0.5 text-[10px] text-red-900/80 dark:text-red-200/75">
            Grouped from the currently loaded ERROR rows — select stage / level filters to narrow the set.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {errorFingerprints.map(([label, n]) => {
              const parts = label.split(' · ')
              const code = parts[0] ?? label
              const stage = parts.slice(1).join(' · ') || '—'
              return (
                <li
                  key={label}
                  className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-red-200/70 bg-white/90 px-2 py-1 text-[10px] font-medium text-red-950 shadow-sm dark:border-red-900/50 dark:bg-gdc-card dark:text-red-100/90"
                >
                  <span className="rounded bg-red-100/90 px-1 py-px font-mono text-[9px] font-semibold uppercase text-red-900 dark:bg-red-950/50 dark:text-red-100">
                    {code}
                  </span>
                  <span className="text-slate-400 dark:text-slate-500">·</span>
                  <span className="max-w-[160px] truncate font-mono text-[9px] uppercase text-slate-700 dark:text-gdc-mutedStrong" title={stage}>
                    {stage}
                  </span>
                  <span className="tabular-nums text-red-700 dark:text-red-300">×{n}</span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <div className="mx-1 mt-4 flex min-w-0 flex-1 flex-col gap-0 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 px-3 pt-3 dark:border-gdc-border">
          <div className="flex gap-1" role="tablist" aria-label="Log severity tabs">
            {(
              [
                ['all', `Logs`],
                ['errors', `Errors (${tabErrorCount})`],
                ['warnings', `Warnings (${tabWarnCount})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tableTab === id}
                onClick={() => setTableTab(id)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-[12px] font-semibold transition-colors',
                  tableTab === id
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-gdc-muted dark:hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 pb-2">
            <button
              type="button"
              onClick={runManualRefresh}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200 dark:hover:bg-gdc-card"
              title="Refresh now"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', pulseFetch && 'animate-spin')} aria-hidden />
              Refresh
            </button>
            <div className="relative" ref={columnsRef}>
              <button
                type="button"
                onClick={() => setColumnsOpen((o) => !o)}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200 dark:hover:bg-gdc-card"
                aria-expanded={columnsOpen}
              >
                <Settings2 className="h-3.5 w-3.5" aria-hidden />
                Columns
                <ChevronDown className="h-3 w-3 text-slate-400 dark:text-gdc-muted" />
              </button>
              {columnsOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 z-40 mt-1 min-w-[13rem] rounded-lg border border-slate-200 bg-white py-1 text-[12px] shadow-lg dark:border-gdc-border dark:bg-gdc-elevated"
                >
                  {(Object.keys(COLUMN_LABELS) as ColumnKey[])
                    .filter((k) => k !== 'expand')
                    .map((key) => (
                      <button
                        key={key}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={visibleCols[key]}
                        disabled={visibleCols[key] && visibleColCount <= 2}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium hover:bg-slate-50 disabled:opacity-40 dark:hover:bg-gdc-card"
                        onClick={() => toggleCol(key)}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                            visibleCols[key]
                              ? 'border-violet-600 bg-violet-600 text-white dark:border-violet-400 dark:bg-violet-500'
                              : 'border-slate-300 dark:border-gdc-borderStrong',
                          )}
                        >
                          {visibleCols[key] ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
                        </span>
                        {COLUMN_LABELS[key]}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              onClick={() => {
                setAutoRefresh((prev) => {
                  const next = !prev
                  persistLogsAutoRefresh(next)
                  return next
                })
              }}
              className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
            >
              <span
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                  autoRefresh ? 'bg-violet-600' : 'bg-slate-200 dark:bg-slate-600',
                )}
              >
                <span
                  className={cn(
                    'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
                    autoRefresh && 'translate-x-4',
                  )}
                />
              </span>
              Auto Refresh
            </button>
            {pollingEnabled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-gdc-input dark:text-gdc-muted">
                <Radio className="h-3 w-3 text-violet-600" aria-hidden />
                Polling · {liveTail ? '5s' : '8s'}
              </span>
            ) : null}
          </div>
        </div>

        <div
          className={cn('relative overflow-x-auto transition-opacity duration-300', pulseFetch && 'opacity-90')}
          aria-busy={logsFetchLoading}
        >
          <table className={opTable}>
            <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_rgb(226_232_240)] dark:shadow-[0_1px_0_0_rgb(35_49_77)]">
              <tr className={cn(opThRow, 'bg-slate-50 dark:bg-gdc-panel')}>
                {visibleCols.expand ? (
                  <th scope="col" className={cn(opTh, 'w-8 bg-slate-50 dark:bg-gdc-panel')} aria-label="Expand" />
                ) : null}
                {visibleCols.time ? (
                  <th scope="col" className={cn(opTh, 'min-w-[140px] bg-slate-50 dark:bg-gdc-panel')}>
                    Time
                  </th>
                ) : null}
                {visibleCols.level ? (
                  <th scope="col" className={cn(opTh, 'min-w-[56px] bg-slate-50 dark:bg-gdc-panel')}>
                    Level
                  </th>
                ) : null}
                {visibleCols.stage ? (
                  <th scope="col" className={cn(opTh, 'min-w-[112px] bg-slate-50 dark:bg-gdc-panel')}>
                    <span className="inline-flex items-center gap-1">
                      Stage
                      <HelpTooltip
                        content={HELP_COPY.runtimeLogStage.content}
                        example={HELP_COPY.runtimeLogStage.example}
                        ariaLabel="Log stage help"
                        side="bottom"
                      />
                    </span>
                  </th>
                ) : null}
                {visibleCols.status ? (
                  <th scope="col" className={cn(opTh, 'min-w-[88px] bg-slate-50 dark:bg-gdc-panel')}>
                    Status
                  </th>
                ) : null}
                {visibleCols.connector ? (
                  <th scope="col" className={cn(opTh, 'min-w-[96px] bg-slate-50 dark:bg-gdc-panel')}>
                    Connector
                  </th>
                ) : null}
                {visibleCols.stream ? (
                  <th scope="col" className={cn(opTh, 'min-w-[88px] bg-slate-50 dark:bg-gdc-panel')}>
                    Stream
                  </th>
                ) : null}
                {visibleCols.route ? (
                  <th scope="col" className={cn(opTh, 'min-w-[120px] bg-slate-50 dark:bg-gdc-panel')}>
                    Route
                  </th>
                ) : null}
                {visibleCols.destination ? (
                  <th scope="col" className={cn(opTh, 'min-w-[120px] bg-slate-50 dark:bg-gdc-panel')}>
                    Destination
                  </th>
                ) : null}
                {visibleCols.latency ? (
                  <th scope="col" className={cn(opTh, 'min-w-[72px] bg-slate-50 dark:bg-gdc-panel')}>
                    Latency
                  </th>
                ) : null}
                {visibleCols.retry ? (
                  <th scope="col" className={cn(opTh, 'min-w-[52px] bg-slate-50 dark:bg-gdc-panel')}>
                    <span className="inline-flex items-center gap-1">
                      Retry
                      <HelpTooltip
                        content={HELP_COPY.runtimeRetry.content}
                        ariaLabel="Retry help"
                        side="bottom"
                      />
                    </span>
                  </th>
                ) : null}
                {visibleCols.message ? (
                  <th scope="col" className={cn(opTh, 'min-w-[220px] bg-slate-50 dark:bg-gdc-panel')}>
                    Message
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {logsFetchLoading && logRows.length === 0 ? (
                <TableSkeletonRows cols={Math.max(1, visibleColCount)} />
              ) : pageRows.length === 0 ? (
                <tr className={opTr}>
                  <td
                    className={cn(opTd, 'py-12 text-center text-sm text-slate-500 dark:text-gdc-muted')}
                    colSpan={Math.max(1, visibleColCount)}
                    data-testid={
                      runtimeLogsError
                        ? 'logs-empty-error'
                        : logsSource === 'empty'
                          ? 'logs-empty-window'
                          : urlHasOperationalFilters
                            ? 'logs-no-match'
                            : 'logs-empty-filters'
                    }
                  >
                    <div className="mx-auto flex max-w-md flex-col items-center gap-3">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        {runtimeLogsError
                          ? 'Runtime logs API failed'
                          : logsSource === 'empty'
                            ? 'No delivery logs in this window'
                            : urlHasOperationalFilters
                              ? 'No logs match the active filters'
                              : 'No logs match the current filters'}
                      </p>
                      <p className="text-sm text-slate-500 dark:text-gdc-muted">
                        {runtimeLogsError
                          ? 'Fix connectivity or permissions, then retry.'
                          : 'Clear filters or open the full logs workspace to widen the search.'}
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            clearOperationalUrlFilters()
                            setSearch('')
                            setLevelFilter('All Levels')
                            setStageFilter('All Stages')
                          }}
                          className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200 dark:hover:bg-gdc-card"
                        >
                          Clear filters
                        </button>
                        <Link
                          to={logsPath()}
                          className="inline-flex h-9 items-center rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                        >
                          Open full logs
                        </Link>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
              {!(logsFetchLoading && logRows.length === 0) &&
                pageRows.map((row) => {
                  const rowSelected = row.id === selectedId
                  const expanded = expandedIds.has(row.id)
                  const st = deliveryStatusPresentation(typeof row.contextJson.status === 'string' ? row.contextJson.status : null)
                  const rid = typeof row.contextJson.route_id === 'number' ? row.contextJson.route_id : null
                  const did = typeof row.contextJson.destination_id === 'number' ? row.contextJson.destination_id : null
                  const cid = typeof row.contextJson.connector_id === 'number' ? row.contextJson.connector_id : null
                  const retryN = safeCtxInt(row.contextJson, 'retry_count') ?? 0
                  const latMs = safeCtxInt(row.contextJson, 'latency_ms')
                  const latencyVal = latMs != null && latMs >= 0 ? latMs : row.durationMs
                  const destName =
                    did != null ? entityLabels.destinations.get(did) ?? destinationFromRouteLabel(row.route) : destinationFromRouteLabel(row.route)
                  const routeLabelText = rid != null ? entityLabels.routes.get(rid) ?? row.route : row.route

                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        opTr,
                        'cursor-pointer',
                        rowSelected ? 'bg-violet-50 dark:bg-violet-950/35' : undefined,
                        row.level === 'ERROR' && 'border-l-[3px] border-l-red-500 bg-red-50/[0.12] dark:border-l-red-500 dark:bg-red-950/15',
                        row.level === 'WARN' && 'border-l-[3px] border-l-amber-400 bg-amber-50/[0.08] dark:border-l-amber-500 dark:bg-amber-950/10',
                      )}
                      onClick={() => setSelectedId(row.id)}
                    >
                      {visibleCols.expand ? (
                        <td className={cn(opTd, 'w-8')} onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-gdc-card dark:hover:text-slate-200"
                            onClick={() =>
                              setExpandedIds((prev) => {
                                const n = new Set(prev)
                                if (n.has(row.id)) n.delete(row.id)
                                else n.add(row.id)
                                return n
                              })
                            }
                          >
                            <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} aria-hidden />
                          </button>
                        </td>
                      ) : null}
                      {visibleCols.time ? (
                        <td className={cn(opTd, 'whitespace-nowrap font-mono text-[11px] text-slate-700 dark:text-gdc-mutedStrong')}>
                          {formatTableTime(row.timeIso)}
                        </td>
                      ) : null}
                      {visibleCols.level ? (
                        <td className={opTd}>
                          <LevelBadge level={row.level} />
                        </td>
                      ) : null}
                      {visibleCols.stage ? (
                        <td className={opTd}>
                          <span className="inline-flex max-w-[min(12rem,22vw)] truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10px] font-bold uppercase leading-tight text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-200">
                            {stageChipText(row)}
                          </span>
                        </td>
                      ) : null}
                      {visibleCols.status ? (
                        <td className={opTd}>
                          <span
                            className={cn(
                              'inline-flex max-w-[10rem] truncate rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase leading-tight',
                              st.tone === 'success' &&
                                'border-emerald-300/80 bg-emerald-500/[0.1] text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100',
                              st.tone === 'warning' &&
                                'border-amber-300/80 bg-amber-500/[0.12] text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100',
                              st.tone === 'danger' &&
                                'border-red-300/80 bg-red-500/[0.1] text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-100',
                              st.tone === 'muted' &&
                                'border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-borderStrong dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
                            )}
                          >
                            {st.label}
                          </span>
                        </td>
                      ) : null}
                      {visibleCols.connector ? (
                        <td className={cn(opTd, 'max-w-[140px] truncate text-[11px] font-medium text-slate-800 dark:text-slate-200')}>
                          {cid != null ? (
                            <Link
                              to={connectorDetailPath(String(cid))}
                              className="text-violet-700 hover:underline dark:text-violet-300"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {entityLabels.connectors.get(cid) ?? row.connector}
                            </Link>
                          ) : (
                            row.connector
                          )}
                        </td>
                      ) : null}
                      {visibleCols.stream ? (
                        <td className={opTd}>
                          {(() => {
                            const sid = typeof row.contextJson.stream_id === 'number' ? row.contextJson.stream_id : null
                            if (sid != null) {
                              return (
                                <Link
                                  to={streamEditPath(String(sid))}
                                  className="text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {row.stream}
                                </Link>
                              )
                            }
                            return <span className="text-[12px] text-slate-700 dark:text-gdc-mutedStrong">{row.stream}</span>
                          })()}
                        </td>
                      ) : null}
                      {visibleCols.route ? (
                        <td className={opTd}>
                          {rid != null ? (
                            <Link
                              to={routeEditPath(String(rid))}
                              className="text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {routeLabelText}
                            </Link>
                          ) : (
                            <span className="text-[11px] text-slate-700 dark:text-gdc-mutedStrong">{row.route}</span>
                          )}
                        </td>
                      ) : null}
                      {visibleCols.destination ? (
                        <td className={cn(opTd, 'max-w-[160px] truncate text-[11px]')}>
                          {did != null ? (
                            <Link
                              to={destinationDetailPath(String(did))}
                              className="font-medium text-violet-700 hover:underline dark:text-violet-300"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {destName}
                            </Link>
                          ) : (
                            <span className="text-slate-700 dark:text-gdc-mutedStrong">{destName}</span>
                          )}
                        </td>
                      ) : null}
                      {visibleCols.latency ? (
                        <td className={cn(opTd, 'whitespace-nowrap font-mono text-[11px] tabular-nums text-slate-700 dark:text-gdc-mutedStrong')}>
                          {formatLatencyMs(latencyVal)}
                        </td>
                      ) : null}
                      {visibleCols.retry ? (
                        <td
                          className={cn(
                            opTd,
                            'tabular-nums font-mono text-[11px]',
                            retryN > 0 ? 'font-semibold text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-gdc-muted',
                          )}
                        >
                          {retryN}
                        </td>
                      ) : null}
                      {visibleCols.message ? (
                        <td className={opTd}>
                          <span className="line-clamp-2 text-[12px] leading-snug text-slate-800 dark:text-slate-200">{row.message}</span>
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>

        <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-slate-200 bg-white/95 px-3 py-2.5 text-[11px] text-slate-600 backdrop-blur-sm dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted sm:flex-row sm:items-center sm:justify-between">
          <p className="tabular-nums">
            Showing {showingFrom} to {showingTo} of {filteredRows.length.toLocaleString()} logs
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40 dark:border-gdc-border dark:text-slate-200 dark:enabled:hover:bg-gdc-input"
              >
                Previous
              </button>
              {pageNumbers.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPage(n)}
                  className={cn(
                    'min-w-[1.75rem] rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums',
                    n === safePage
                      ? 'bg-violet-600 text-white shadow-sm dark:bg-violet-500'
                      : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-gdc-input',
                  )}
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                disabled={nextPageDisabled}
                onClick={() => {
                  void (async () => {
                    if (safePage < totalPages) {
                      setPage((p) => Math.min(totalPages, p + 1))
                      return
                    }
                    if (canServerPageMore) {
                      const appended = await loadMoreLogsPage()
                      if (appended) setPage((p) => p + 1)
                    }
                  })()
                }}
                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40 dark:border-gdc-border dark:text-slate-200 dark:enabled:hover:bg-gdc-input"
              >
                Next
              </button>
            </div>
            <label className="flex items-center gap-1.5 font-semibold">
              <span className="sr-only">Rows per page</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  setPage(1)
                }}
                className="h-8 rounded-lg border border-slate-200 bg-white py-1 pl-2 pr-7 text-[11px] font-semibold text-slate-800 dark:border-gdc-inputBorder dark:bg-gdc-input dark:text-slate-100"
              >
                {[10, 25, 50].map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {selected ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-slate-900/25 backdrop-blur-[1px]"
            aria-label="Close log details"
            onClick={() => setSelectedId(null)}
          />
          <aside
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-gdc-border dark:bg-gdc-elevated"
            aria-label="Log details"
          >
            <LogDetailDrawer row={selected} onClose={() => setSelectedId(null)} />
          </aside>
        </>
      ) : null}

      <p className="mx-1 mt-4 flex items-start gap-2 border-t border-slate-200 pt-3 text-[10px] leading-relaxed text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
        <Filter className="mt-0.5 h-3 w-3 shrink-0 text-slate-400 dark:text-gdc-muted" aria-hidden />
        Uses Runtime API when available (<code className="rounded bg-slate-100 px-0.5 dark:bg-gdc-input">logs/page</code>, then{' '}
        <code className="rounded bg-slate-100 px-0.5 dark:bg-gdc-input">logs/search</code>
        ); KPI counts reflect the loaded sample. Dashboard summary uses{' '}
        <code className="rounded bg-slate-100 px-0.5 dark:bg-gdc-input">dashboard/summary</code>.
        {streamSlug ? (
          <>
            {' '}
            Scoped path:{' '}
            <Link className="font-semibold text-violet-700 hover:underline dark:text-violet-300" to={logsPath()}>
              All logs
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}
