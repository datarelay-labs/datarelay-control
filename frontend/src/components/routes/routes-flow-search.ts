/** Shared, case-normalized Route Flow quick-find predicates.
 *
 * Used by compact mobile and desktop expert views; never reads a new backend
 * inventory or changes the authoritative Runtime Snapshot.
 */
import { routePublicId, type RouteFlowRouteRow, type RouteFlowStreamGroup } from './routes-flow-helpers'

export function routeMatchesQuery(route: RouteFlowRouteRow, query: string): boolean {
  return String(route.routeId).includes(query) ||
    routePublicId(route.routeId).toLowerCase().includes(query) ||
    route.routeLabel.toLowerCase().includes(query) ||
    route.destinationName.toLowerCase().includes(query) ||
    (route.destinationId != null && String(route.destinationId).includes(query))
}

export function streamMatchesQuery(group: RouteFlowStreamGroup, query: string): boolean {
  return group.streamName.toLowerCase().includes(query) || String(group.streamId).includes(query)
}
