import { ChevronDown, ChevronRight, ArrowRight, Activity } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { NAV_PATH, destinationDetailPath, logsExplorerPath, routeEditPath, streamRuntimePath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import {
  formatFlowEps,
  formatFlowErrorRate,
  formatFlowSuccessRate,
  routeHealthBadgeClass,
  routePublicId,
  type RouteFlowStreamGroup,
} from './routes-flow-helpers'

const FIRST_ROUTES = 12
const NEXT_ROUTES = 20

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
      {groups.map((group) => (
        <CompactStreamGroup
          key={group.streamId}
          group={group}
          expanded={expandedIds.has(group.streamId)}
          onToggle={() => onToggle(group.streamId)}
          validObservationTime={validObservationTime}
          evidenceStale={evidenceStale}
        />
      ))}
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
  evidenceStale,
  validObservationTime,
}: {
  group: RouteFlowStreamGroup
  expanded: boolean
  onToggle: () => void
  evidenceStale: boolean
  validObservationTime: boolean
}) {
  const [shown, setShown] = useState(FIRST_ROUTES)
  const count = group.routes.length
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
        </div>
      </div>
      {expanded ? (
        <ol className="space-y-2 p-3">
          {group.routes.slice(0, shown).map((route) => {
            const canLinkDestination = route.destinationId != null &&
              Number.isSafeInteger(route.destinationId) && route.destinationId > 0
            const displayHealth = !validObservationTime
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
                      !validObservationTime || evidenceStale
                        ? 'border-slate-300 bg-slate-100 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong'
                        : routeHealthBadgeClass(route.health),
                    )}
                  >
                    {!route.enabled ? 'Disabled · ' : null}{displayHealth}
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
          {shown < count ? (
            <li>
              <button
                type="button"
                aria-label={`Show next Routes (${shown} of ${count} shown)`}
                onClick={() => setShown((previous) => Math.min(previous + NEXT_ROUTES, count))}
                className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-section dark:text-violet-300"
              >
                Show next Routes ({Math.min(shown, count)} of {count} shown)
              </button>
            </li>
          ) : null}
        </ol>
      ) : null}
    </article>
  )
}
