import { Link } from 'react-router-dom'
import { logsExplorerPath } from '../../config/nav-paths'
import { routePublicId, type RouteFlowRouteRow } from './routes-flow-helpers'

/**
 * Read-only failed-attempt investigation, grounded in existing numeric Route
 * evidence. This is not an assertion of current failure or receiver ingestion.
 */
export function RouteFlowFailedAttemptLink({
  route,
  streamId,
  evidenceStale,
  validObservationTime,
  className,
}: {
  route: Pick<RouteFlowRouteRow, 'routeId' | 'destinationId' | 'enabled' | 'errorRatePct'>
  streamId: number
  evidenceStale: boolean
  validObservationTime: boolean
  className?: string
}) {
  if (
    !route.enabled ||
    !validObservationTime ||
    route.errorRatePct == null ||
    !Number.isFinite(route.errorRatePct) ||
    route.errorRatePct <= 0 ||
    !Number.isSafeInteger(route.routeId) ||
    route.routeId <= 0 ||
    !Number.isSafeInteger(streamId) ||
    streamId <= 0
  ) {
    return null
  }

  const destinationId = route.destinationId != null &&
    Number.isSafeInteger(route.destinationId) && route.destinationId > 0
      ? route.destinationId
      : undefined
  return (
    <Link
      to={logsExplorerPath({
        route_id: route.routeId,
        stream_id: streamId,
        destination_id: destinationId,
        status: 'failed',
      })}
      aria-label={`Investigate ${routePublicId(route.routeId)} failed attempts`}
      className={className ?? 'font-semibold text-amber-800 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-amber-300'}
    >
      {evidenceStale ? 'Last reported failures' : 'Failed attempts'}
    </Link>
  )
}
