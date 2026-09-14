import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchDestinationsList, type DestinationListItem } from '../../api/gdcDestinations'
import { clearDestinationHealthCache, fetchDestinationHealthList } from '../../api/gdcRuntimeHealth'
import { clearOperationalSnapshotCache, getOperationalSnapshot, type OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { DestinationHealthRow } from '../../api/types/gdcApi'
import type { StreamsMetricsWindow } from '../../constants/streamConsoleFilters'
import { isRequestAborted } from '../../lib/request-abort'
import {
  buildDestinationRuntimeLookup,
  listRuntimeMetricsForDestination,
  type DestinationListRuntimeMetrics,
} from './destination-runtime-metrics'
import { readDestinationsListSnapshot, writeDestinationsListSnapshot } from './destinations-list-cache'

export type DestinationOverviewRow = DestinationListItem & {
  runtime: DestinationListRuntimeMetrics
}

export type DestinationsOverviewDataState = {
  rows: DestinationOverviewRow[]
  loading: boolean
  runtimeLoading: boolean
  error: string | null
  runtimeError: string | null
  refresh: () => Promise<void>
}

export type UseDestinationsOverviewDataParams = {
  timeRange: StreamsMetricsWindow
  refreshVersion: number
}

export function useDestinationsOverviewData({
  timeRange,
  refreshVersion,
}: UseDestinationsOverviewDataParams): DestinationsOverviewDataState {
  const sessionRows = readDestinationsListSnapshot()
  const [catalogRows, setCatalogRows] = useState<DestinationListItem[]>(() => sessionRows ?? [])
  const [catalogLoading, setCatalogLoading] = useState(() => (sessionRows?.length ?? 0) === 0)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [runtimeLookup, setRuntimeLookup] = useState(() => buildDestinationRuntimeLookup(null))
  const [operationalSnapshot, setOperationalSnapshot] = useState<OperationalSnapshotResponse | null>(null)
  const [healthByDestinationId, setHealthByDestinationId] = useState<Map<number, DestinationHealthRow>>(() => new Map())
  const catalogRef = useRef(catalogRows)
  catalogRef.current = catalogRows
  const catalogGenRef = useRef(0)
  const runtimeGenRef = useRef(0)
  const catalogAbortRef = useRef<AbortController | null>(null)
  const runtimeAbortRef = useRef<AbortController | null>(null)

  const loadCatalog = useCallback(async (options?: { background?: boolean }) => {
    const gen = ++catalogGenRef.current
    catalogAbortRef.current?.abort()
    const abort = new AbortController()
    catalogAbortRef.current = abort
    const background = options?.background === true && catalogRef.current.length > 0
    if (!background) {
      setCatalogLoading(true)
      setCatalogError(null)
    }
    try {
      const data = await fetchDestinationsList({ signal: abort.signal })
      if (gen !== catalogGenRef.current || abort.signal.aborted) return
      if (data === null) {
        setCatalogError('Failed to load destinations. Check authentication and API connectivity.')
        if (!background) {
          // Keep any previously loaded rows; do not masquerade failure as an empty catalog.
        }
        return
      }
      setCatalogRows(data)
      writeDestinationsListSnapshot(data)
      setCatalogError(null)
    } catch (err) {
      if (abort.signal.aborted || gen !== catalogGenRef.current) return
      if (!isRequestAborted(err)) {
        setCatalogError(err instanceof Error ? err.message : 'Failed to load destinations.')
        if (!background) setCatalogRows([])
      }
    } finally {
      if (gen === catalogGenRef.current && !background) setCatalogLoading(false)
    }
  }, [])

  const loadRuntime = useCallback(async () => {
    const gen = ++runtimeGenRef.current
    runtimeAbortRef.current?.abort()
    const abort = new AbortController()
    runtimeAbortRef.current = abort
    setRuntimeLoading(true)
    setRuntimeError(null)
    try {
      const [snapshot, healthList] = await Promise.all([
        getOperationalSnapshot(),
        fetchDestinationHealthList({
          window: timeRange,
          scoring_mode: 'historical_analytics',
        }),
      ])
      if (gen !== runtimeGenRef.current || abort.signal.aborted) return
      if (snapshot == null && healthList == null) {
        setRuntimeError('Could not load destination runtime data.')
        setOperationalSnapshot(null)
        setRuntimeLookup(buildDestinationRuntimeLookup(null))
        setHealthByDestinationId(new Map())
        return
      }
      setOperationalSnapshot(snapshot)
      setRuntimeLookup(buildDestinationRuntimeLookup(snapshot))
      const healthMap = new Map<number, DestinationHealthRow>()
      for (const row of healthList?.rows ?? []) {
        healthMap.set(row.destination_id, row)
      }
      setHealthByDestinationId(healthMap)
      if (snapshot == null && (healthList?.rows?.length ?? 0) === 0) {
        setRuntimeError('Could not load operational snapshot.')
      }
    } catch (err) {
      if (abort.signal.aborted || gen !== runtimeGenRef.current) return
      if (!isRequestAborted(err)) {
        setRuntimeError(err instanceof Error ? err.message : 'Failed to load destination runtime data.')
        setOperationalSnapshot(null)
        setRuntimeLookup(buildDestinationRuntimeLookup(null))
        setHealthByDestinationId(new Map())
      }
    } finally {
      if (gen === runtimeGenRef.current) setRuntimeLoading(false)
    }
  }, [timeRange])

  const refresh = useCallback(async () => {
    clearOperationalSnapshotCache()
    clearDestinationHealthCache()
    const hasSession = (readDestinationsListSnapshot()?.length ?? 0) > 0
    await Promise.all([loadCatalog({ background: hasSession }), loadRuntime()])
  }, [loadCatalog, loadRuntime])

  useEffect(() => {
    const hasSession = (readDestinationsListSnapshot()?.length ?? 0) > 0
    void loadCatalog({ background: hasSession })
  }, [loadCatalog, refreshVersion])

  useEffect(() => {
    void loadRuntime()
  }, [loadRuntime, refreshVersion])

  useEffect(() => {
    return () => {
      catalogGenRef.current += 1
      runtimeGenRef.current += 1
      catalogAbortRef.current?.abort()
      runtimeAbortRef.current?.abort()
    }
  }, [])

  const rows = useMemo(
    (): DestinationOverviewRow[] =>
      catalogRows.map((row) => ({
        ...row,
        runtime: listRuntimeMetricsForDestination(
          row,
          runtimeLookup,
          operationalSnapshot,
          healthByDestinationId.get(row.id) ?? null,
          timeRange,
        ),
      })),
    [catalogRows, runtimeLookup, operationalSnapshot, healthByDestinationId, timeRange],
  )

  return {
    rows,
    loading: catalogLoading,
    runtimeLoading,
    error: catalogError,
    runtimeError,
    refresh,
  }
}
