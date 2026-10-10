import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { NAV_PATH, destinationDetailPath, logsExplorerPath, routeEditPath, streamRuntimePath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { useMediaQuery } from '../../hooks/use-media-query'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  buildRouteFlowTree,
  formatFlowEps,
  formatFlowErrorRate,
  formatFlowSuccessRate,
  isRouteSnapshotStale,
  routeHealthBadgeClass,
  routePublicId,
  type RouteFlowStreamGroup,
} from './routes-flow-helpers'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { RoutesFlowCompactCards } from './routes-flow-compact-cards'
import { RouteFlowFailedAttemptLink } from './routes-flow-failed-attempt-link'
import { routeMatchesQuery, streamMatchesQuery } from './routes-flow-search'
import type { RouteConsoleRow } from './routes-overview-helpers'

const INITIAL_EXPANDED_STREAM_LIMIT = 8
const INITIAL_VISIBLE_ROUTES_PER_STREAM = 12
const NEXT_ROUTE_PAGE_SIZE = 20

// NiFi-style operator summary filtering; evaluate only existing snapshot data.
function needsRouteAttention(route: RouteFlowStreamGroup['routes'][number]): boolean {
  return route.enabled && (route.health === 'Error' || route.health === 'Warning')
}

export type RoutesFlowTreeTableProps = {
  snapshot: OperationalSnapshotResponse | null
  consoleRows: readonly RouteConsoleRow[]
  loading?: boolean
}

export function RoutesFlowTreeTable({ snapshot, consoleRows, loading = false }: RoutesFlowTreeTableProps) {
  const isNarrowViewport = useMediaQuery('(max-width: 767px)')
  const groups = useMemo(() => buildRouteFlowTree(snapshot, consoleRows), [snapshot, consoleRows])
  const snapshotTime = snapshot?.updated_at ? Date.parse(snapshot.updated_at) : NaN
  const validObservationTime = Number.isFinite(snapshotTime)
  const evidenceStale = isRouteSnapshotStale(snapshot?.updated_at)
  const verifiedEmpty = !loading && snapshot != null && !evidenceStale &&
    snapshot.global?.total_routes === 0 && snapshot.routes.length === 0
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set())
  const [expertSearch, setExpertSearch] = useState('')
  const [expertAttentionOnly, setExpertAttentionOnly] = useState(false)
  // Temporary filtered expansion must not overwrite manual collapse preferences.
  const [searchCollapsedIds, setSearchCollapsedIds] = useState<Set<number>>(() => new Set())
  const expertQuery = expertSearch.trim().toLowerCase()
  const expertFiltered = Boolean(expertQuery) || expertAttentionOnly
  const expertCandidates = useMemo(() => {
    if (!expertAttentionOnly) return groups
    return groups.flatMap((group) => {
      const routes = group.routes.filter(needsRouteAttention).sort((a, b) =>
        Number(b.health === 'Error') - Number(a.health === 'Error') || a.routeId - b.routeId)
      return routes.length > 0 ? [{ ...group, routes }] : []
    }).sort((a, b) =>
      Number(b.routes.some((route) => route.health === 'Error')) -
      Number(a.routes.some((route) => route.health === 'Error')) || a.streamId - b.streamId)
  }, [expertAttentionOnly, groups])
  const expertMatches = useMemo(() => {
    if (!expertQuery) return expertCandidates
    // Match the mobile search rule: an exact Stream ID takes precedence.
    const exactStream = /^\d+$/.test(expertQuery)
      ? expertCandidates.find((group) => String(group.streamId) === expertQuery)
      : undefined
    if (exactStream) return [exactStream]
    return expertCandidates.flatMap((group) => {
      if (streamMatchesQuery(group, expertQuery)) return [group]
      const routes = group.routes.filter((route) => routeMatchesQuery(route, expertQuery))
      return routes.length > 0 ? [{ ...group, routes }] : []
    })
  }, [expertQuery, expertCandidates])
  const knownStreamIds = useRef<Set<number>>(new Set())
  const expandNewStreams = useRef<'initial' | 'all' | 'none'>('initial')

  useEffect(() => {
    // A transient unavailable/loading snapshot must not erase the operator's
    // manual collapse choice. The next authoritative snapshot reconciles IDs.
    if (!snapshot || loading) return
    const nextKnown = new Set(groups.map((group) => group.streamId))
    const previouslyKnown = knownStreamIds.current
    setExpandedIds((previous) => {
      const next = new Set([...previous].filter((id) => nextKnown.has(id)))
      // Initial render and newly discovered Streams are shown in a bounded
      // first set. Existing IDs retain manual expand/collapse across refresh.
      for (const [index, group] of groups.entries()) {
        if (!previouslyKnown.has(group.streamId) &&
            (expandNewStreams.current === 'all' ||
              (expandNewStreams.current === 'initial' && index < INITIAL_EXPANDED_STREAM_LIMIT))) {
          next.add(group.streamId)
        }
      }
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) {
        return previous
      }
      return next
    })
    knownStreamIds.current = nextKnown
  }, [groups, snapshot, loading])

  const allExpanded = groups.length > 0 && groups.every((group) => expandedIds.has(group.streamId))

  function toggleStream(streamId: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(streamId)) next.delete(streamId)
      else next.add(streamId)
      return next
    })
  }

  function toggleSearchedStream(streamId: number) {
    setSearchCollapsedIds((previous) => {
      const next = new Set(previous)
      if (next.has(streamId)) next.delete(streamId)
      else next.add(streamId)
      return next
    })
  }

  function toggleAll() {
    expandNewStreams.current = allExpanded ? 'none' : 'all'
    if (allExpanded) {
      setExpandedIds(new Set())
    } else {
      setExpandedIds(new Set(groups.map((g) => g.streamId)))
    }
  }

  return (
    <section
      aria-label="Route flow"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Route Flow</h3>
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
            Stream → route → destination delivery at a glance
          </p>
          <p
            role="status"
            data-testid="routes-flow-snapshot-status"
            className="mt-1 text-[11px] text-slate-600 dark:text-gdc-mutedStrong"
          >
            {loading && !snapshot
              ? 'Loading route evidence'
              : !snapshot
                ? 'Runtime snapshot unavailable'
                : !validObservationTime
                  ? 'Snapshot time not verified'
                  : evidenceStale
                    ? <>Stale · last reported <time dateTime={snapshot.updated_at}>{new Date(snapshotTime).toISOString()}</time></>
                    : <>As of <time dateTime={snapshot.updated_at}>{new Date(snapshotTime).toISOString()}</time> (UTC)</>}
          </p>
        </div>
        {groups.length > 0 && !(expertFiltered && !isNarrowViewport) ? (
          <div className="flex flex-wrap items-center gap-3">
            <span
              data-testid="routes-flow-expanded-summary"
              role="status"
              className="text-[11px] text-slate-600 dark:text-gdc-mutedStrong"
            >
              {groups.filter((group) => expandedIds.has(group.streamId)).length} of {groups.length} Streams expanded
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="min-h-9 rounded-md px-2 text-[11px] font-semibold text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
            >
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
        ) : null}
      </div>
      {!isNarrowViewport && groups.length > 0 ? (
        <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50/50 px-3 py-3 dark:border-gdc-border dark:bg-gdc-section/30 sm:flex-row sm:flex-wrap sm:items-center">
          <label className="shrink-0 text-xs font-semibold text-slate-700 dark:text-gdc-mutedStrong" htmlFor="route-flow-expert-find">
            Find a delivery path
          </label>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-gdc-muted" aria-hidden />
            <input
              id="route-flow-expert-find"
              type="search"
              aria-label="Find in expert Route Flow"
              autoComplete="off"
              placeholder="Stream, Route, Destination name or ID"
              value={expertSearch}
              onChange={(event) => {
                setExpertSearch(event.target.value)
                setSearchCollapsedIds(new Set())
              }}
              className="min-h-10 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            />
          </div>
          <button
            type="button"
            aria-label="Show only enabled Routes needing attention in expert table"
            aria-pressed={expertAttentionOnly}
            onClick={() => {
              setExpertAttentionOnly((current) => !current)
              setSearchCollapsedIds(new Set())
            }}
            className={cn(
              'min-h-10 shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500',
              expertAttentionOnly
                ? 'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100'
                : 'border-slate-200 bg-white text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
            )}
          >
            Attention only
          </button>
          {expertAttentionOnly ? (
            <span data-testid="routes-flow-desktop-attention-context" className="text-[11px] text-slate-600 dark:text-gdc-mutedStrong">
              {!validObservationTime || evidenceStale
                ? 'Last reported Error/Warning paths — not current incident confirmation; Stream EPS includes all Routes'
                : 'Snapshot-reported Error/Warning — not receiver ingestion proof; Stream EPS includes all Routes'}
            </span>
          ) : null}
          {expertQuery ? (
            <button
              type="button"
              aria-label="Clear expert Route search"
              onClick={() => {
                setExpertSearch('')
                setSearchCollapsedIds(new Set())
              }}
              className="min-h-10 shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:text-violet-300"
            >
              Clear search
            </button>
          ) : null}
          <p
            role="status"
            data-testid="routes-flow-expert-find-status"
            className="text-[11px] leading-5 text-slate-600 dark:text-gdc-mutedStrong"
          >
            {expertFiltered
              ? `${expertMatches.length} matching Stream${expertMatches.length === 1 ? '' : 's'} in loaded snapshot`
              : 'Search the already-loaded Stream → Route → Destination inventory'}
          </p>
        </div>
      ) : null}
      {isNarrowViewport ? (
        <RoutesFlowCompactCards
          groups={groups}
          expandedIds={expandedIds}
          onToggle={toggleStream}
          loading={loading}
          verifiedEmpty={verifiedEmpty}
          evidenceStale={evidenceStale}
          validObservationTime={validObservationTime}
        />
      ) : (
      <div className="overflow-x-auto">
        <table className={opTable} aria-label="Expert Route delivery table">
          <thead>
            <tr className={opThRow}>
              <th className={cn(opTh, 'min-w-[200px]')}>Stream</th>
              <th className={cn(opTh, 'min-w-[180px]')}>Route / Destination</th>
              <th className={cn(opTh, 'min-w-[88px]')}>Throughput (EPS)</th>
              <th className={cn(opTh, 'min-w-[88px]')}>Success Rate</th>
              <th className={cn(opTh, 'min-w-[72px]')}>Error Rate</th>
              <th className={cn(opTh, 'min-w-[80px]')}>Health</th>
            </tr>
          </thead>
          <tbody>
            {loading && groups.length === 0
              ? Array.from({ length: 4 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-slate-100/90 dark:border-gdc-divider">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="px-2.5 py-2">
                        <div className="h-2.5 animate-pulse rounded bg-slate-200/90 dark:bg-gdc-elevated" />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {!loading && groups.length === 0 ? (
              <tr className={opTr}>
                <td
                  data-testid="routes-flow-inventory-state"
                  className={cn(opTd, 'py-8 text-center text-[12px] text-slate-500')}
                  colSpan={6}
                >
                  {verifiedEmpty ? (
                    'No routes configured yet.'
                  ) : (
                    <>
                      Route inventory not verified. Inspect current Stream state before creating another Route.{' '}
                      <Link to={NAV_PATH.streams} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
                        View Streams
                      </Link>
                    </>
                  )}
                </td>
              </tr>
            ) : null}
            {expertFiltered && groups.length > 0 && expertMatches.length === 0 ? (
              <tr className={opTr}>
                <td colSpan={6} data-testid="routes-flow-no-expert-matches" className={cn(opTd, 'py-8 text-center text-xs text-amber-900 dark:text-amber-200')}>
                  {expertAttentionOnly
                    ? 'No enabled Error or Warning Routes match the selected filters in the loaded snapshot.'
                    : 'No matching Streams, Routes or Destinations in the loaded snapshot.'}
                  This filter does not prove receiver ingestion or delivery success.
                </td>
              </tr>
            ) : null}
            {(expertFiltered ? expertMatches : groups).map((group) => (
              <StreamFlowRows
                key={group.streamId}
                group={group}
                evidenceStale={evidenceStale}
                validObservationTime={validObservationTime}
                matchOnly={expertFiltered}
                expanded={expertFiltered ? !searchCollapsedIds.has(group.streamId) : expandedIds.has(group.streamId)}
                onToggle={() => {
                  if (expertFiltered) toggleSearchedStream(group.streamId)
                  else toggleStream(group.streamId)
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      )}
    </section>
  )
}

function StreamFlowRows({
  group,
  evidenceStale,
  validObservationTime,
  matchOnly,
  expanded,
  onToggle,
}: {
  group: RouteFlowStreamGroup
  evidenceStale: boolean
  validObservationTime: boolean
  matchOnly: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const routeCount = group.routes.length
  const [visibleRouteCount, setVisibleRouteCount] = useState(INITIAL_VISIBLE_ROUTES_PER_STREAM)
  const shownRouteCount = Math.min(visibleRouteCount, routeCount)
  return (
    <Fragment>
      <tr className={cn(opTr, 'bg-slate-50/60 dark:bg-gdc-section/50')}>
        <td className={cn(opTd, 'font-semibold')}>
          <div className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-slate-900 dark:text-slate-100">
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.streamName} routes`}
              onClick={onToggle}
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md hover:bg-slate-200/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:hover:bg-gdc-elevated"
            >
              {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
            </button>
            <Link
              to={streamRuntimePath(String(group.streamId))}
              className="min-w-0 break-words font-semibold hover:text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:hover:text-violet-300"
            >
              {group.streamName}
            </Link>
          </div>
        </td>
        <td className={cn(opTd, 'text-[11px] text-slate-500 dark:text-gdc-muted')}>
          {routeCount} {matchOnly ? 'matching route' : 'route'}{routeCount === 1 ? '' : 's'}
        </td>
        <td className={cn(opTd, 'tabular-nums text-[11px] font-semibold text-slate-900 dark:text-slate-50')}>
          {formatFlowEps(group.totalEps)}
        </td>
        <td className={opTd} colSpan={3} />
      </tr>
      {expanded
        ? group.routes.slice(0, shownRouteCount).map((route, idx) => {
            const isLast = idx === group.routes.length - 1
            const prefix = isLast ? '└' : '├'
            return (
              <tr key={route.routeId} className={cn(opTr, !route.enabled && 'opacity-55')}>
                <td className={opTd} />
                <td className={cn(opTd, 'pl-4')}>
                  <div className="flex items-start gap-2">
                    <span className="font-mono text-[11px] text-slate-400 dark:text-gdc-muted" aria-hidden>
                      {prefix}
                    </span>
                    <div className="min-w-0">
                      <Link
                        to={routeEditPath(String(route.routeId))}
                        className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                      >
                        {route.routeLabel !== routePublicId(route.routeId) ? route.routeLabel : routePublicId(route.routeId)}
                      </Link>
                      <div className="truncate text-[11px] text-slate-600 dark:text-gdc-muted">{route.destinationName}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                        <Link
                          to={logsExplorerPath({
                            route_id: route.routeId,
                            stream_id: group.streamId,
                            destination_id: route.destinationId ?? undefined,
                          })}
                          aria-label={`Investigate ${routePublicId(route.routeId)} delivery logs`}
                          className="font-medium text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
                        >
                          Delivery logs
                        </Link>
                        <RouteFlowFailedAttemptLink
                          route={route}
                          streamId={group.streamId}
                          evidenceStale={evidenceStale}
                          validObservationTime={validObservationTime}
                        />
                        {route.destinationId != null ? (
                          <Link
                            to={destinationDetailPath(String(route.destinationId))}
                            aria-label={`View ${route.destinationName} destination`}
                            className="font-medium text-slate-600 hover:text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-gdc-mutedStrong dark:hover:text-violet-300"
                          >
                            Destination details
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </td>
                <td className={cn(opTd, 'tabular-nums text-[11px] font-semibold')}>{formatFlowEps(route.eps)}</td>
                <td className={cn(opTd, 'tabular-nums text-[11px]')}>{formatFlowSuccessRate(route.successRatePct)}</td>
                <td className={cn(opTd, 'tabular-nums text-[11px]')}>{formatFlowErrorRate(route.errorRatePct)}</td>
                <td className={opTd}>
                  <span
                    data-testid={`routes-flow-route-health-${route.routeId}`}
                    className={cn(
                      'inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                      !route.enabled || !validObservationTime || evidenceStale
                        ? 'border-slate-300 bg-slate-100 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong'
                        : routeHealthBadgeClass(route.health),
                    )}
                  >
                    {!route.enabled ? 'Disabled' : !validObservationTime ? 'Unverified' : evidenceStale ? `Last reported ${route.health}` : route.health}
                  </span>
                </td>
              </tr>
            )
          })
        : null}
      {expanded && shownRouteCount < routeCount ? (
        <tr className={opTr}>
          <td className={opTd} />
          <td className={cn(opTd, 'pl-4')} colSpan={5}>
            <button
              type="button"
              aria-label={`Show next Routes (${shownRouteCount} of ${routeCount} shown)`}
              onClick={() => setVisibleRouteCount((previous) => Math.min(previous + NEXT_ROUTE_PAGE_SIZE, routeCount))}
              className="min-h-9 rounded-md px-3 text-[11px] font-semibold text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
            >
              Show next Routes ({shownRouteCount} of {routeCount} shown)
            </button>
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}
