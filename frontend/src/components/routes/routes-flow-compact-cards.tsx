import { ChevronDown, ChevronRight, ArrowRight, Activity, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { NAV_PATH, destinationDetailPath, logsExplorerPath, routeEditPath, runtimeAnalyticsPath, streamRuntimePath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { RouteFlowFailedAttemptLink } from './routes-flow-failed-attempt-link'
import { routeMatchesQuery, streamMatchesQuery } from './routes-flow-search'
import {
  formatFlowEps,
  formatFlowErrorRate,
  formatFlowSuccessRate,
  routeHealthBadgeClass,
  routePublicId,
  type RouteFlowStreamGroup,
  type RouteFlowRouteRow,
} from './routes-flow-helpers'

const FIRST_ROUTES = 12
const NEXT_ROUTES = 20
const FIRST_STREAMS = 12
const NEXT_STREAMS = 20

function isRouteAttention(route: RouteFlowRouteRow): boolean {
  return route.enabled && (route.health === 'Error' || route.health === 'Warning')
}

function routeAttentionPriority(route: RouteFlowRouteRow): number {
  return route.health === 'Error' ? 0 : route.health === 'Warning' ? 1 : 2
}

function streamAttentionPriority(group: RouteFlowStreamGroup): number {
  return group.routes.some((route) => isRouteAttention(route) && route.health === 'Error') ? 0 : 1
}

/** Operator-native cards for narrow viewports; pure presentation of an existing snapshot. */
export function RoutesFlowCompactCards({
  groups,
  expandedIds,
  onToggle,
  loading,
  verifiedEmpty,
  evidenceStale,
  validObservationTime,
}: {
  groups: readonly RouteFlowStreamGroup[]
  expandedIds: ReadonlySet<number>
  onToggle: (streamId: number) => void
  loading: boolean
  verifiedEmpty: boolean
  evidenceStale: boolean
  validObservationTime: boolean
}) {
  const [shownStreams, setShownStreams] = useState(FIRST_STREAMS)
  const [streamSearch, setStreamSearch] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const query = streamSearch.trim().toLowerCase()
  // Triaging reported gateway Errors/Warnings is independent of and scoped
  // by the same already-loaded snapshot; disabled paths are not live alerts.
  const eligibleGroups = attentionOnly
    ? groups.filter((group) => group.routes.some(isRouteAttention)).sort((a, b) =>
        streamAttentionPriority(a) - streamAttentionPriority(b) || a.streamId - b.streamId,
      )
    : groups
  // A bare exact Stream ID takes precedence over a coincidentally matching
  // Route/Destination ID. Explicit R- IDs or receiver names search all paths.
  const exactStream = /^\d+$/.test(query)
    ? eligibleGroups.find((group) => String(group.streamId) === query)
    : undefined
  const matches = query
    ? exactStream
      ? [exactStream]
      : eligibleGroups.filter((group) =>
          streamMatchesQuery(group, query) || group.routes.some((route) =>
            (!attentionOnly || isRouteAttention(route)) && routeMatchesQuery(route, query)),
        )
    : eligibleGroups
  const visibleStreams = Math.min(matches.length, shownStreams)
  return (
    <section aria-label="Compact route delivery" data-testid="routes-flow-compact-cards" className="space-y-3 p-3">
      {loading && groups.length === 0 ? (
        <p role="status" className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600 dark:bg-gdc-section dark:text-gdc-muted">
          Loading route evidence
        </p>
      ) : null}
      {!loading && groups.length === 0 ? (
        <div
          data-testid="routes-flow-inventory-state"
          className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong"
        >
          {verifiedEmpty ? 'No routes configured yet.' : (
            <>
              Route inventory not verified. Inspect current Stream state before creating another Route.{' '}
              <Link className="font-semibold text-violet-700 underline-offset-4 hover:underline dark:text-violet-300" to={NAV_PATH.streams}>
                View Streams
              </Link>
            </>
          )}
        </div>
      ) : null}
      {groups.length > 0 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-gdc-muted" aria-hidden />
          <input
            type="search"
            aria-label="Find Stream, Route or Destination"
            autoComplete="off"
            value={streamSearch}
            onChange={(event) => {
              setStreamSearch(event.target.value)
              setShownStreams(FIRST_STREAMS)
            }}
            placeholder="Find Stream, Route or Destination"
            className="min-h-11 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          />
        </div>
      ) : null}
      {groups.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="Show only enabled Routes needing attention"
            aria-pressed={attentionOnly}
            onClick={() => {
              setAttentionOnly((current) => !current)
              setShownStreams(FIRST_STREAMS)
            }}
            className={cn(
              'min-h-11 rounded-lg border px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500',
              attentionOnly
                ? 'border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100'
                : 'border-slate-200 bg-white text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
            )}
          >
            Attention only
          </button>
          {attentionOnly ? (
            <span className="text-[11px] text-slate-600 dark:text-gdc-mutedStrong">
              {evidenceStale || !validObservationTime
                ? 'Last reported Error/Warning evidence — not current incident confirmation'
                : 'Snapshot-reported Error/Warning paths, not receiver ingestion proof'}
            </span>
          ) : null}
        </div>
      ) : null}
      {attentionOnly && matches.length === 0 && groups.length > 0 ? (
        <p role="status" aria-label="Route attention filter result" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-gdc-border dark:bg-gdc-panel dark:text-gdc-mutedStrong">
          No enabled Error or Warning Routes reported for the loaded snapshot{query ? ' matching this search' : ''}; not proof of receiver ingestion.
        </p>
      ) : query && matches.length === 0 ? (
        <p role="status" aria-label="Flow search result" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          No matching Streams, Routes or Destinations in the currently loaded snapshot. Change the search to inspect other available paths.
        </p>
      ) : null}
      {matches.slice(0, visibleStreams).map((group) => (
        <CompactStreamGroup
          key={group.streamId}
          group={group}
          expanded={expandedIds.has(group.streamId)}
          onToggle={() => onToggle(group.streamId)}
          routeQuery={query && !streamMatchesQuery(group, query) ? query : null}
          attentionOnly={attentionOnly}
          validObservationTime={validObservationTime}
          evidenceStale={evidenceStale}
        />
      ))}
      {visibleStreams < matches.length ? (
        <button
          type="button"
          aria-label={`Show next Streams (${visibleStreams} of ${matches.length} shown)`}
          onClick={() => setShownStreams((count) => Math.min(count + NEXT_STREAMS, matches.length))}
          className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-section dark:text-violet-300"
        >
          Show next Streams ({visibleStreams} of {matches.length} shown)
        </button>
      ) : null}
      {groups.length > 0 ? (
        <p className="text-[11px] leading-5 text-slate-500 dark:text-gdc-muted">
          Gateway Route attempts are reported here; downstream receiver ingestion not confirmed. Inspect per-Route logs before concluding delivery.
        </p>
      ) : null}
    </section>
  )
}

function CompactStreamGroup({
  group,
  expanded,
  onToggle,
  routeQuery,
  attentionOnly,
  evidenceStale,
  validObservationTime,
}: {
  group: RouteFlowStreamGroup
  expanded: boolean
  onToggle: () => void
  routeQuery: string | null
  attentionOnly: boolean
  evidenceStale: boolean
  validObservationTime: boolean
}) {
  const [shown, setShown] = useState(FIRST_ROUTES)
  const count = group.routes.length
  const visibleRoutes = group.routes.filter((route) =>
    (!attentionOnly || isRouteAttention(route)) && (routeQuery == null || routeMatchesQuery(route, routeQuery)))
  // Sort a filtered copy, not the authoritative snapshot or parent group.
  if (attentionOnly) visibleRoutes.sort((a, b) => routeAttentionPriority(a) - routeAttentionPriority(b) || a.routeId - b.routeId)
  const shownCount = Math.min(shown, visibleRoutes.length)
  return (
    <article
      className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid={`routes-flow-mobile-stream-${group.streamId}`}
    >
      <div className="flex min-w-0 items-center gap-2 bg-slate-50/80 p-3 dark:bg-gdc-section/50">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.streamName} routes`}
          onClick={onToggle}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-elevated"
        >
          {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        </button>
        <div className="min-w-0 flex-1">
          <Link
            to={streamRuntimePath(String(group.streamId))}
            className="block break-words text-sm font-semibold text-slate-900 underline-offset-4 hover:text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-slate-100 dark:hover:text-violet-300"
          >
            {group.streamName}
          </Link>
          <p className="text-xs text-slate-600 dark:text-gdc-mutedStrong">
            {count} Route{count === 1 ? '' : 's'} · Gateway {formatFlowEps(group.totalEps)} EPS
          </p>
          {routeQuery || attentionOnly ? (
            <p role="status" className="mt-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
              {visibleRoutes.length} {attentionOnly ? 'reported Error/Warning' : 'matching'} Route{visibleRoutes.length === 1 ? '' : 's'} of {count}
              {!expanded ? ' · Expand to inspect' : ''}
            </p>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <ol className="space-y-2 p-3">
          {visibleRoutes.slice(0, shownCount).map((route) => {
            const canLinkDestination = route.destinationId != null &&
              Number.isSafeInteger(route.destinationId) && route.destinationId > 0
            const displayHealth = !route.enabled
              ? 'Disabled'
              : !validObservationTime
                ? 'Unverified'
                : evidenceStale
                  ? `Last reported ${route.health}`
                  : route.health
            return (
              <li
                key={route.routeId}
                className={cn(
                  'rounded-lg border border-slate-200/90 bg-white px-3 py-3 dark:border-gdc-border dark:bg-gdc-card',
                  !route.enabled && 'opacity-65',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={routeEditPath(String(route.routeId))}
                      className="inline-block min-h-7 break-words text-sm font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
                    >
                      {route.routeLabel !== routePublicId(route.routeId) ? route.routeLabel : routePublicId(route.routeId)}
                    </Link>
                    <p className="break-words text-xs text-slate-600 dark:text-gdc-mutedStrong">
                      → {route.destinationName}
                    </p>
                  </div>
                  <span
                    data-testid={`routes-flow-mobile-health-${route.routeId}`}
                    className={cn(
                      'inline-flex max-w-full rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-wide',
                      !route.enabled || !validObservationTime || evidenceStale
                        ? 'border-slate-300 bg-slate-100 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong'
                        : routeHealthBadgeClass(route.health),
                    )}
                  >
                    {displayHealth}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-1.5 rounded-lg bg-slate-50/90 p-2 text-center dark:bg-gdc-panel">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-medium text-slate-500 dark:text-gdc-muted">Gateway EPS</dt>
                    <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{formatFlowEps(route.eps)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-medium text-slate-500 dark:text-gdc-muted">Success</dt>
                    <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{formatFlowSuccessRate(route.successRatePct)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-medium text-slate-500 dark:text-gdc-muted">Errors</dt>
                    <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{formatFlowErrorRate(route.errorRatePct)}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                  <Link
                    to={logsExplorerPath({
                      route_id: route.routeId,
                      stream_id: group.streamId,
                      destination_id: canLinkDestination ? route.destinationId ?? undefined : undefined,
                    })}
                    aria-label={`Investigate ${routePublicId(route.routeId)} delivery logs`}
                    className="inline-flex min-h-10 items-center gap-1 font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
                  >
                    <Activity className="h-3.5 w-3.5" aria-hidden /> Delivery logs <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                  <RouteFlowFailedAttemptLink
                    route={route}
                    streamId={group.streamId}
                    evidenceStale={evidenceStale}
                    validObservationTime={validObservationTime}
                    className="inline-flex min-h-10 items-center font-semibold text-amber-800 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-amber-300"
                  />
                  {Number.isSafeInteger(route.routeId) && route.routeId > 0 &&
                    Number.isSafeInteger(group.streamId) && group.streamId > 0 ? (
                      <Link
                        to={runtimeAnalyticsPath({
                          window: '24h',
                          stream_id: group.streamId,
                          route_id: route.routeId,
                          destination_id: canLinkDestination ? route.destinationId ?? undefined : undefined,
                        })}
                        aria-label={`Inspect ${routePublicId(route.routeId)} delivery trends (24h)`}
                        className="inline-flex min-h-10 items-center font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
                      >
                        24h trends
                      </Link>
                    ) : null}
                  {canLinkDestination ? (
                    <Link
                      to={destinationDetailPath(String(route.destinationId))}
                      aria-label={`View ${route.destinationName} destination`}
                      className="inline-flex min-h-10 items-center font-medium text-slate-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-gdc-mutedStrong"
                    >
                      Destination details
                    </Link>
                  ) : null}
                </div>
              </li>
            )
          })}
          {shownCount < visibleRoutes.length ? (
            <li>
              <button
                type="button"
                aria-label={`Show next Routes (${shownCount} of ${visibleRoutes.length} shown)`}
                onClick={() => setShown((previous) => Math.min(previous + NEXT_ROUTES, visibleRoutes.length))}
                className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-section dark:text-violet-300"
              >
                Show next Routes ({shownCount} of {visibleRoutes.length} shown)
              </button>
            </li>
          ) : null}
        </ol>
      ) : null}
    </article>
  )
}
