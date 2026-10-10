import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { NAV_PATH, destinationDetailPath, logsExplorerPath, routeEditPath, streamRuntimePath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
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
import type { RouteConsoleRow } from './routes-overview-helpers'

export type RoutesFlowTreeTableProps = {
  snapshot: OperationalSnapshotResponse | null
  consoleRows: readonly RouteConsoleRow[]
  loading?: boolean
}

export function RoutesFlowTreeTable({ snapshot, consoleRows, loading = false }: RoutesFlowTreeTableProps) {
  const groups = useMemo(() => buildRouteFlowTree(snapshot, consoleRows), [snapshot, consoleRows])
  const snapshotTime = snapshot?.updated_at ? Date.parse(snapshot.updated_at) : NaN
  const validObservationTime = Number.isFinite(snapshotTime)
  const evidenceStale = isRouteSnapshotStale(snapshot?.updated_at)
  const verifiedEmpty = !loading && snapshot != null && !evidenceStale &&
    snapshot.global?.total_routes === 0 && snapshot.routes.length === 0
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    setExpandedIds(new Set(groups.map((g) => g.streamId)))
  }, [groups])

  const allExpanded = groups.length > 0 && expandedIds.size >= groups.length

  function toggleStream(streamId: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(streamId)) next.delete(streamId)
      else next.add(streamId)
      return next
    })
  }

  function toggleAll() {
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
        {groups.length > 0 ? (
          <button
            type="button"
            onClick={toggleAll}
            className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        ) : null}
      </div>
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
            {groups.map((group) => (
              <StreamFlowRows
                key={group.streamId}
                group={group}
                evidenceStale={evidenceStale}
                expanded={expandedIds.has(group.streamId)}
                onToggle={() => toggleStream(group.streamId)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StreamFlowRows({
  group,
  evidenceStale,
  expanded,
  onToggle,
}: {
  group: RouteFlowStreamGroup
  evidenceStale: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const routeCount = group.routes.length
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
          {routeCount} route{routeCount === 1 ? '' : 's'}
        </td>
        <td className={cn(opTd, 'tabular-nums text-[11px] font-semibold text-slate-900 dark:text-slate-50')}>
          {formatFlowEps(group.totalEps)}
        </td>
        <td className={opTd} colSpan={3} />
      </tr>
      {expanded
        ? group.routes.map((route, idx) => {
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
                      evidenceStale
                        ? 'border-slate-300 bg-slate-100 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong'
                        : routeHealthBadgeClass(route.health),
                    )}
                  >
                    {evidenceStale ? `Last reported ${route.health}` : route.health}
                  </span>
                </td>
              </tr>
            )
          })
        : null}
    </Fragment>
  )
}
