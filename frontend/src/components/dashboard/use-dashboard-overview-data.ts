import { useCallback, useEffect, useRef, useState } from 'react'
import { GDC_HEADER_REFRESH_EVENT } from '../layout/header-refresh-event'
import type { ExtendedMetricsWindow } from '../../api/gdcRuntime'
import {
  fetchRuntimeAlertSummary,
  fetchRuntimeDashboardOutcomeTimeseries,
  fetchRuntimeDashboardSummary,
  invalidateDashboardAnalyticsCache,
} from '../../api/gdcRuntime'
import { fetchConnectorsList, type ConnectorRead } from '../../api/gdcConnectors'
import { fetchDestinationsList, type DestinationListItem } from '../../api/gdcDestinations'
import { clearOperationalSnapshotCache, getOperationalSnapshot, type OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { canUseOperationalFixture } from '../../lib/runtime-operational-fixture-mode'
import { fetchStreamsList } from '../../api/gdcStreams'
import type {
  DashboardOutcomeTimeseriesResponse,
  DashboardSummaryResponse,
  RuntimeAlertSummaryResponse,
  StreamRead,
} from '../../api/types/gdcApi'
import { shouldSuppressApiLoadError } from '../../auth/password-change-gate'
import { useMountAbortController } from '../../hooks/use-mount-abort-signal'
import { isRequestAborted } from '../../lib/request-abort'
import { logDashboardClientMetric } from '../../telemetry/dashboardClientMetrics'

export type DashboardOverviewBundle = {
  dashboard: DashboardSummaryResponse | null
  /** True when the dashboard summary API call failed (engine status may be incorrect). */
  dashboardFailed: boolean
  alerts: RuntimeAlertSummaryResponse | null
  /** True when the alerts API call failed (0-count must not be shown as "No alerts"). */
  alertsFailed: boolean
  outcomeTs: DashboardOutcomeTimeseriesResponse | null
  streams: StreamRead[]
  connectors: ConnectorRead[]
  /** False until the Connector catalog request has returned a valid list. */
  connectorsKnown: boolean
  destinations: DestinationListItem[] | null
  operationalSnapshot: OperationalSnapshotResponse | null
  /** True when the operational snapshot came from a dev fixture file, not the live API. */
  isFixtureMode: boolean
}

const EMPTY_DASHBOARD_BUNDLE: DashboardOverviewBundle = {
  dashboard: null,
  dashboardFailed: false,
  alerts: null,
  alertsFailed: false,
  outcomeTs: null,
  streams: [],
  connectors: [],
  connectorsKnown: false,
  destinations: null,
  operationalSnapshot: null,
  isFixtureMode: false,
}

/** Wall-clock ceiling for deferred dashboard bundle (ms). */
const DASHBOARD_BUNDLE_DEADLINE_MS = 20_000

function unwrapDeferred<T>(result: PromiseSettledResult<T | null | undefined>): T | null {
  if (result.status === 'fulfilled') return result.value ?? null
  return null
}

function unwrapDeferredList<T>(result: PromiseSettledResult<T[] | null | undefined>): T[] {
  if (result.status === 'fulfilled') return result.value ?? []
  return []
}

function mergeDeferredBundle(
  operationalSnapshot: NonNullable<DashboardOverviewBundle['operationalSnapshot']>,
  isFixtureMode: boolean,
  settled: [
    PromiseSettledResult<Awaited<ReturnType<typeof fetchRuntimeDashboardSummary>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof fetchRuntimeAlertSummary>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof fetchStreamsList>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof fetchConnectorsList>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof fetchDestinationsList>>>,
  ],
): DashboardOverviewBundle {
  const [
    dashboardResult,
    alertsResult,
    streamsResult,
    connectorsResult,
    destinationsResult,
  ] = settled

  return {
    operationalSnapshot,
    isFixtureMode,
    dashboard: unwrapDeferred(dashboardResult),
    dashboardFailed: dashboardResult.status === 'rejected',
    alerts: unwrapDeferred(alertsResult),
    alertsFailed: alertsResult.status === 'rejected',
    outcomeTs: null,
    streams: unwrapDeferredList(streamsResult),
    connectors: unwrapDeferredList(connectorsResult),
    connectorsKnown: connectorsResult.status === 'fulfilled' && Array.isArray(connectorsResult.value),
    destinations: unwrapDeferred(destinationsResult),
  }
}

export function useDashboardOverviewData(window: ExtendedMetricsWindow, refreshMs: number | null) {
  const abortRef = useMountAbortController()
  const [bundle, setBundle] = useState<DashboardOverviewBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadInFlightRef = useRef<Promise<void> | null>(null)
  const loadGenerationRef = useRef(0)
  // Tracks whether at least one successful partial bundle has been set.
  // Used to avoid flashing the loading spinner on subsequent refreshes.
  const hasInitialBundleRef = useRef(false)

  const load = useCallback(async () => {
    if (loadInFlightRef.current != null) {
      logDashboardClientMetric('dashboard_poll_skipped', { reason: 'previous_poll_pending' })
      return
    }
    const token = ++loadGenerationRef.current
    const run = (async () => {
      const signal = abortRef.current?.signal
      const fetchOpts = { signal }
      // Only show the full loading spinner on the very first load.
      if (!hasInitialBundleRef.current) {
        setLoading(true)
      }
      setLoadError(null)
      try {
        const deadline = new Promise<never>((_, reject) => {
          globalThis.setTimeout(() => {
            reject(new Error('Operations dashboard request exceeded the 20s timeout. Check network or API latency and retry.'))
          }, DASHBOARD_BUNDLE_DEADLINE_MS)
        })
        // If load aborts before Promise.race attaches, avoid an unhandled rejection.
        void deadline.catch(() => undefined)

        const deferredPromise = Promise.allSettled([
          fetchRuntimeDashboardSummary(800, window, {}, fetchOpts),
          fetchRuntimeAlertSummary(window, 40, fetchOpts),
          fetchStreamsList(fetchOpts),
          fetchConnectorsList(fetchOpts),
          fetchDestinationsList(fetchOpts),
        ])

        const operationalSnapshot = await getOperationalSnapshot()
        if (token !== loadGenerationRef.current) return
        if (operationalSnapshot == null) {
          setLoadError('Could not load operational snapshot.')
          setBundle(EMPTY_DASHBOARD_BUNDLE)
          return
        }

        hasInitialBundleRef.current = true
        setBundle({
          ...EMPTY_DASHBOARD_BUNDLE,
          operationalSnapshot,
          isFixtureMode: false,
        })
        setLoading(false)

        const [settled, isFixtureMode] = await Promise.all([
          Promise.race([deferredPromise, deadline]),
          canUseOperationalFixture(),
        ])

        if (token !== loadGenerationRef.current) return

        setBundle(mergeDeferredBundle(operationalSnapshot, isFixtureMode, settled))

        void fetchRuntimeDashboardOutcomeTimeseries(window, {}, fetchOpts)
          .then((outcomeTs) => {
            if (token !== loadGenerationRef.current) return
            if (outcomeTs == null) return
            setBundle((prev) => (prev == null ? prev : { ...prev, outcomeTs }))
          })
          .catch((err) => {
            if (isRequestAborted(err)) return
            if (import.meta.env.DEV) {
              console.warn('[dashboard overview] outcome timeseries deferred load failed', err)
            }
          })
      } catch (err) {
        if (isRequestAborted(err)) return
        if (shouldSuppressApiLoadError(err)) {
          if (token !== loadGenerationRef.current) return
          setLoadError(null)
          setLoading(false)
          return
        }
        const timedOut =
          err instanceof Error &&
          (err.message.includes('20s timeout') ||
            err.name === 'AbortError' ||
            err.message.toLowerCase().includes('aborted'))
        if (timedOut) {
          logDashboardClientMetric('dashboard_fetch_timeout', { deadline_ms: DASHBOARD_BUNDLE_DEADLINE_MS })
        }
        if (import.meta.env.DEV) {
          console.error('[dashboard overview] load failed', err)
        }
        const msg = err instanceof Error ? err.message : 'Could not load the dashboard.'
        if (token !== loadGenerationRef.current) return
        setLoadError(msg)
        setBundle((prev) => (prev?.operationalSnapshot != null ? prev : EMPTY_DASHBOARD_BUNDLE))
      } finally {
        if (token === loadGenerationRef.current) {
          setLoading(false)
        }
      }
    })()

    const guarded = run.finally(() => {
      if (loadInFlightRef.current === guarded) {
        loadInFlightRef.current = null
      }
    })
    loadInFlightRef.current = guarded
    await guarded
  }, [window, abortRef])

  /** Manual reload: clears analytics caches so fresh data is always fetched. */
  const manualReload = useCallback(() => {
    invalidateDashboardAnalyticsCache()
    clearOperationalSnapshotCache()
    return load()
  }, [load])

  useEffect(() => {
    void load()
    return () => {
      loadGenerationRef.current += 1
      loadInFlightRef.current = null
    }
  }, [load])

  useEffect(() => {
    if (refreshMs == null || refreshMs <= 0) return
    // Auto-refresh: does NOT clear caches — lets TTL govern staleness.
    const id = globalThis.setInterval(() => void load(), refreshMs)
    return () => globalThis.clearInterval(id)
  }, [refreshMs, load])

  useEffect(() => {
    const w = globalThis.window
    if (!w) return
    // Header refresh button is a manual gesture — clear analytics caches.
    const onShellRefresh = () => void manualReload()
    w.addEventListener(GDC_HEADER_REFRESH_EVENT, onShellRefresh)
    return () => w.removeEventListener(GDC_HEADER_REFRESH_EVENT, onShellRefresh)
  }, [manualReload])

  return { bundle, loading, loadError, reload: manualReload }
}
