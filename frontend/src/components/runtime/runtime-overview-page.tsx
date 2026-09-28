import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { MetricsWindow } from '../../api/gdcRuntime'
import type { OperationalProblem } from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
import { RuntimeOperationalProvider, useRuntimeOperational } from './runtime-operational-provider'
import { resolveUrlFiltersFromSnapshot } from './runtime-overview-helpers'
import {
  RuntimeCommandCenterSections,
  RuntimeOverviewHeader,
  RuntimeStreamFocusAside,
  RuntimeUrlFilterChips,
} from './runtime-overview-sections'
import { RuntimeFixtureModeBanner } from './runtime-fixture-mode-banner'
import { RuntimeRetentionSection } from './RuntimeRetentionSection'

function RuntimeOverviewContent() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { snapshot, loading } = useRuntimeOperational()
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('1h')
  const [focusStreamId, setFocusStreamId] = useState<number | null>(null)

  const queryStreamId = useMemo(() => {
    const v = searchParams.get('stream_id')
    return v && /^\d+$/.test(v) ? Number(v) : undefined
  }, [searchParams])

  const queryRouteId = useMemo(() => {
    const v = searchParams.get('route_id')
    return v && /^\d+$/.test(v) ? Number(v) : undefined
  }, [searchParams])

  const queryDestinationId = useMemo(() => {
    const v = searchParams.get('destination_id')
    return v && /^\d+$/.test(v) ? Number(v) : undefined
  }, [searchParams])

  const urlResolved = useMemo(() => {
    if (snapshot == null) {
      return {
        effectiveStreamId: null as number | null,
        highlightRouteId: queryRouteId ?? null,
        highlightDestinationId: queryDestinationId ?? null,
        error: null as ReturnType<typeof resolveUrlFiltersFromSnapshot>['error'],
      }
    }
    return resolveUrlFiltersFromSnapshot(snapshot, {
      streamId: queryStreamId,
      routeId: queryRouteId,
      destinationId: queryDestinationId,
    })
  }, [snapshot, queryStreamId, queryRouteId, queryDestinationId])

  useEffect(() => {
    if (loading || urlResolved.error) return
    if (urlResolved.effectiveStreamId != null) {
      setFocusStreamId(urlResolved.effectiveStreamId)
    }
  }, [loading, urlResolved.effectiveStreamId, urlResolved.error])

  useEffect(() => {
    if (focusStreamId == null && snapshot?.streams.length) {
      setFocusStreamId(snapshot.streams[0]!.stream_id)
    }
  }, [snapshot?.streams, focusStreamId])

  const removeRuntimeUrlParam = useCallback(
    (key: 'stream_id' | 'route_id' | 'destination_id') => {
      const next = new URLSearchParams(searchParams)
      next.delete(key)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const onFocusProblem = useCallback((problem: OperationalProblem) => {
    if (problem.stream_id != null) setFocusStreamId(problem.stream_id)
  }, [])

  const focusStreamName =
    focusStreamId != null ? snapshot?.streams.find((s) => s.stream_id === focusStreamId)?.stream_name ?? null : null

  const urlFilterBanner = useMemo(() => {
    const hasFilters = queryStreamId != null || queryRouteId != null || queryDestinationId != null
    if (!hasFilters || loading) return null
    if (urlResolved.error === 'route_not_found') return 'Invalid route filter: route was not found.'
    if (urlResolved.error === 'stream_mismatch') return 'Invalid filters: route does not belong to the selected stream.'
    if (urlResolved.error === 'no_route_for_destination') return 'Invalid destination filter: no route targets this destination.'
    if (urlResolved.effectiveStreamId != null && !snapshot?.streams.some((s) => s.stream_id === urlResolved.effectiveStreamId)) {
      return 'Stream filter does not match any stream in the operational snapshot.'
    }
    return null
  }, [queryStreamId, queryRouteId, queryDestinationId, loading, urlResolved, snapshot?.streams])

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
      <div className="min-w-0 flex-1 space-y-4">
        <RuntimeOverviewHeader metricsWindow={metricsWindow} onMetricsWindowChange={setMetricsWindow} />
        <RuntimeFixtureModeBanner surface="runtime" />
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={NAV_PATH.analytics}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-violet-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-300 dark:hover:bg-gdc-rowHover"
          >
            Delivery analytics
          </Link>
          <RuntimeUrlFilterChips
            queryStreamId={queryStreamId ?? null}
            queryRouteId={queryRouteId ?? null}
            queryDestinationId={queryDestinationId ?? null}
            streamName={focusStreamName}
            onRemove={removeRuntimeUrlParam}
          />
        </div>
        {urlFilterBanner ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/35 dark:text-amber-50"
          >
            {urlFilterBanner}
          </div>
        ) : null}
        <RuntimeCommandCenterSections
          focusStreamId={focusStreamId}
          onFocusStream={setFocusStreamId}
          onFocusProblem={onFocusProblem}
          metricsWindow={metricsWindow}
        />
        <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
          Operational status refreshes from the current snapshot. Detailed stream analytics load only when requested.
        </p>
      </div>
      <div className="w-full shrink-0 space-y-3 lg:w-[280px]">
        <RuntimeStreamFocusAside focusStreamId={focusStreamId} highlightRouteId={urlResolved.highlightRouteId} />
        <RuntimeRetentionSection />
      </div>
    </div>
  )
}

export function RuntimeOverviewPage() {
  return (
    <RuntimeOperationalProvider>
      <RuntimeOverviewContent />
    </RuntimeOperationalProvider>
  )
}
