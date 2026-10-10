import { ArrowLeft, ArrowUpRight, GitBranch } from 'lucide-react'
import { Link } from 'react-router-dom'
import { NAV_PATH, destinationDetailPath, routeEditPath, runtimeAnalyticsPath } from '../../config/nav-paths'

/** A direct, read-only investigation return path; never changes event state. */
export function LogsRouteReturnActions({
  routeId,
  canConfigure,
  destinationId,
  streamId,
}: {
  routeId: number | undefined
  canConfigure: boolean
  destinationId?: number
  streamId?: number
}) {
  if (routeId == null || !Number.isSafeInteger(routeId) || routeId <= 0) return null
  return (
    <section
      aria-label="Route investigation next actions"
      data-testid="logs-route-investigation-return"
      className="mt-3 flex flex-col gap-2 rounded-lg border border-violet-100 bg-violet-50/55 px-3 py-2.5 dark:border-violet-900/40 dark:bg-violet-950/15 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-violet-700 dark:text-violet-300" aria-hidden />
          Investigating Route #{routeId}
        </p>
        <p className="mt-1 max-w-xl text-[11px] leading-5 text-slate-600 dark:text-gdc-mutedStrong">
          {canConfigure
            ? 'Opening settings does not resend or verify events. Log evidence may be unavailable or outside the selected time window.'
            : 'Read-only access. An operator can review Route configuration; missing logs do not prove successful delivery.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <Link
          to={NAV_PATH.routes}
          className="inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to Data Flows
        </Link>
        <Link
          to={runtimeAnalyticsPath({
            window: '24h',
            stream_id: streamId,
            route_id: routeId,
            destination_id: destinationId,
          })}
          className="inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
        >
          View Route #{routeId} delivery trends (24h)
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
        {destinationId != null && Number.isSafeInteger(destinationId) && destinationId > 0 ? (
          <Link
            to={destinationDetailPath(String(destinationId))}
            className="inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
          >
            Inspect Destination #{destinationId}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
        {canConfigure ? (
          <Link
            to={routeEditPath(String(routeId))}
            className="inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
          >
            Review Route #{routeId} configuration
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
    </section>
  )
}
