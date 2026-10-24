import { MarkerType, Position, type Edge, type Node } from '@xyflow/react'
import type { OperationalSnapshotResponse, OperationalHealthStatus } from '../../api/operationalSnapshot'
import { destinationDetailPath, routeEditPath, streamRuntimePath } from '../../config/nav-paths'

export type FlowNodeData = Record<string, unknown> & {
  label: string
  detail: string
  kind: 'source' | 'stream' | 'route' | 'destination'
  href: string | null
  status: string
}
export type FlowEdgeData = Record<string, unknown> & {
  routeId: number | null
  evidence: string
  observedEps: number | null
  gatewayOnly: boolean
}
export type RuntimeFlowTopology = {
  nodes: Node<FlowNodeData>[]
  edges: Edge<FlowEdgeData>[]
  shownRoutes: number
  totalRoutes: number
  routePage: number
  stale: boolean
}

const safeId = (id: number | null | undefined): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0

/** A recent snapshot is required to animate gateway-reported delivery. */
export function snapshotIsFresh(timestamp: string | null | undefined, nowMs = Date.now()): boolean {
  const observed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
  return Number.isFinite(observed) && nowMs >= observed && nowMs - observed <= 90_000
}

const stateClass = (status: OperationalHealthStatus | string, enabled: boolean): string =>
  !enabled ? 'control-runtime-flow-node--disabled'
    : status === 'ERROR' ? 'control-runtime-flow-node--error'
      : status === 'DEGRADED' ? 'control-runtime-flow-node--warning'
        : status === 'HEALTHY' ? 'control-runtime-flow-node--healthy'
          : 'control-runtime-flow-node--unknown'

function node(
  id: string, x: number, y: number, data: FlowNodeData, statusClass: string,
): Node<FlowNodeData> {
  return {
    id,
    position: { x, y },
    data,
    type: 'default',
    draggable: false,
    connectable: false,
    selectable: true,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    className: `control-runtime-flow-node ${statusClass}`,
  }
}
function edge(
  id: string, source: string, target: string,
  evidence: FlowEdgeData, active = false,
): Edge<FlowEdgeData> {
  return {
    id, source, target, data: evidence, type: 'default', animated: active,
    className: active ? 'control-runtime-flow-edge--active' : 'control-runtime-flow-edge--static',
    selectable: true,
    interactionWidth: 22,
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
  }
}

export const MAX_MOVING_GATEWAY_PATHS = 16
/** A readable viewport replaces one unusably compressed 40-Route diagram. */
export const MAX_VISIBLE_FLOW_ROUTES = 6

/**
 * Keep animation bounded and entirely coupled to verified rate-positive edges.
 * The remaining Route edges and their numeric evidence stay visible and selectable.
 * Frozen/hidden/reduced-motion views never retain a glowing active edge class.
 */
export function selectRuntimeMotionEdges(
  edges: readonly Edge<FlowEdgeData>[],
  allowMotion: boolean,
  selectedRouteId: number | null = null,
): Edge<FlowEdgeData>[] {
  const eligible = edges.filter((item) =>
    item.animated === true && item.data?.gatewayOnly === true &&
    typeof item.data.observedEps === 'number' &&
    Number.isFinite(item.data.observedEps) && item.data.observedEps > 0)
    .sort((a, b) =>
      Number(b.data?.routeId === selectedRouteId) - Number(a.data?.routeId === selectedRouteId) ||
      (b.data?.observedEps ?? 0) - (a.data?.observedEps ?? 0) ||
      a.id.localeCompare(b.id))
  const moving = new Set(
    allowMotion ? eligible.slice(0, MAX_MOVING_GATEWAY_PATHS).map((item) => item.id) : [],
  )
  return edges.map((item) => {
    const isMoving = moving.has(item.id)
    return {
      ...item,
      type: item.data?.gatewayOnly ? 'runtime-delivery' : 'default',
      animated: isMoving,
      className: isMoving
        ? 'control-runtime-flow-edge--active'
        : 'control-runtime-flow-edge--static',
    }
  })
}

/**
 * A read-only projection, never a configuration or receiver-acknowledgement model.
 * Missing IDs and metrics are omitted rather than guessed. One selected Stream
 * bounds the graph while existing Stream selection remains the navigation control.
 */
export function buildRuntimeFlowTopology(
  snapshot: OperationalSnapshotResponse | null,
  selectedStreamId: number | null,
  selectedRouteId: number | null = null,
  nowMs = Date.now(),
  routePage: number | null = null,
): RuntimeFlowTopology {
  const empty: RuntimeFlowTopology = {
    nodes: [], edges: [], shownRoutes: 0, totalRoutes: 0, routePage: 0, stale: true,
  }
  if (!snapshot || !safeId(selectedStreamId)) return empty
  const stream = snapshot.streams.find((candidate) => candidate.stream_id === selectedStreamId)
  if (!stream) return empty

  const fresh = snapshotIsFresh(snapshot.updated_at, nowMs)
  const streamKnownStopped = ['STOPPED', 'STOPPING', 'PAUSED', 'DISABLED', 'ERROR', 'FAILED']
    .includes((stream.status || '').trim().toUpperCase())
  const streamCanDeliver = stream.enabled && !streamKnownStopped &&
    (stream.health_status === 'HEALTHY' || stream.health_status === 'DEGRADED')
  const allRoutes = snapshot.routes
    .filter((route) => safeId(route.route_id) && route.stream_id === selectedStreamId)
    .sort((a, b) => a.route_id - b.route_id)
  const totalPages = Math.max(1, Math.ceil(allRoutes.length / MAX_VISIBLE_FLOW_ROUTES))
  const selectedRouteIndex = allRoutes.findIndex((route) => route.route_id === selectedRouteId)
  const selectedPage = selectedRouteIndex >= 0
    ? Math.floor(selectedRouteIndex / MAX_VISIBLE_FLOW_ROUTES) : 0
  // An explicit page comes only from the operator's page controls; otherwise
  // automatically show the page containing the selected workspace Route.
  const page = routePage !== null && Number.isSafeInteger(routePage) && routePage >= 0
    ? Math.min(routePage, totalPages - 1) : selectedPage
  const visible = allRoutes.slice(
    page * MAX_VISIBLE_FLOW_ROUTES, (page + 1) * MAX_VISIBLE_FLOW_ROUTES,
  )

  const nodes: Node<FlowNodeData>[] = []
  const edges: Edge<FlowEdgeData>[] = []
  const centerY = Math.max(0, (visible.length - 1) * 96 / 2)
  const streamNodeId = `stream:${stream.stream_id}`
  nodes.push(node(streamNodeId, 242, centerY, {
    kind: 'stream',
    label: stream.stream_name || `Stream #${stream.stream_id}`,
    detail: `Stream #${stream.stream_id} · ${stream.enabled ? stream.health_status : 'Disabled'}`,
    href: streamRuntimePath(String(stream.stream_id)),
    status: stream.enabled ? stream.health_status : 'Disabled',
  }, stateClass(stream.health_status, stream.enabled)))

  const sourceId = safeId(stream.source_id) ? `source:${stream.source_id}`
    : safeId(stream.connector_id) ? `connector:${stream.connector_id}` : null
  if (sourceId) {
    const label = safeId(stream.source_id) ? `Source #${stream.source_id}`
      : `Connector #${stream.connector_id}`
    nodes.push(node(sourceId, 0, centerY, {
      kind: 'source', label,
      detail: 'Upstream relation · ingestion is not verified by delivery rates',
      href: null, status: 'Topology only',
    }, 'control-runtime-flow-node--unknown'))
    edges.push(edge(`${sourceId}->${streamNodeId}`, sourceId, streamNodeId, {
      routeId: null, evidence: 'Configuration relation · ingestion not verified',
      observedEps: null, gatewayOnly: false,
    }))
  }

  const destinationIds = new Map<number, number[]>()
  const byDestination = new Map(snapshot.destinations
    .filter((d) => safeId(d.destination_id))
    .map((d) => [d.destination_id, d]))

  visible.forEach((route, index) => {
    const routeY = index * 96
    const routeNodeId = `route:${route.route_id}`
    nodes.push(node(routeNodeId, 510, routeY, {
      kind: 'route', label: `Route #${route.route_id}`,
      detail: route.enabled ? route.health_status : 'Disabled',
      href: routeEditPath(String(route.route_id)),
      status: route.enabled ? route.health_status : 'Disabled',
    }, stateClass(route.health_status, route.enabled)))
    edges.push(edge(`${streamNodeId}->${routeNodeId}`, streamNodeId, routeNodeId, {
      routeId: route.route_id, evidence: 'Configured Stream → Route processing path',
      observedEps: null, gatewayOnly: false,
    }))
    if (!safeId(route.destination_id)) return
    const positions = destinationIds.get(route.destination_id) ?? []
    positions.push(routeY)
    destinationIds.set(route.destination_id, positions)
    const destinationNodeId = `destination:${route.destination_id}`
    const destination = byDestination.get(route.destination_id)
    const reportedRate = Number.isFinite(route.delivered_eps_1m) && route.delivered_eps_1m >= 0
      ? route.delivered_eps_1m : null
    const destinationCanReceive = destination?.enabled === true &&
      (destination.health_status === 'HEALTHY' || destination.health_status === 'DEGRADED')
    const flowing = fresh && streamCanDeliver && route.enabled && destinationCanReceive &&
      (route.health_status === 'HEALTHY' || route.health_status === 'DEGRADED') &&
      reportedRate !== null && reportedRate > 0
    const evidence = !fresh ? 'Stale snapshot · delivery activity unknown'
      : !streamCanDeliver ? 'Stream stopped, disabled or unhealthy · current delivery not verified'
        : !route.enabled ? 'Disabled Route · no active delivery claim'
          : route.health_status === 'ERROR' ? 'Route error · current delivery not verified'
            : destination?.enabled !== true ? 'Destination unavailable or disabled'
              : !destinationCanReceive ? 'Destination error or idle · current delivery not verified'
                : reportedRate === null ? 'Delivery rate unavailable'
            : reportedRate === 0 ? '0 gateway-reported delivered EPS in 1m window'
              : `${reportedRate.toFixed(2)} gateway-reported delivered EPS · 1m · receiver unverified`
    edges.push(edge(`${routeNodeId}->${destinationNodeId}`, routeNodeId, destinationNodeId, {
      routeId: route.route_id, evidence, observedEps: reportedRate, gatewayOnly: true,
    }, flowing))
  })

  for (const [destinationId, ys] of destinationIds) {
    const destination = byDestination.get(destinationId)
    const y = ys.reduce((sum, value) => sum + value, 0) / ys.length
    nodes.push(node(`destination:${destinationId}`, 804, y, {
      kind: 'destination', label: destination?.destination_name ||
        visible.find((route) => route.destination_id === destinationId)?.destination_name ||
        `Destination #${destinationId}`,
      detail: destination
        ? `${destination.destination_type || 'Destination'} · ${destination.enabled ? destination.health_status : 'Disabled'}`
        : 'Destination metadata unavailable',
      href: destination ? destinationDetailPath(String(destinationId)) : null,
      status: destination ? (destination.enabled ? destination.health_status : 'Disabled') : 'Unknown',
    }, stateClass(destination?.health_status || 'IDLE', destination?.enabled === true)))
  }
  return { nodes, edges, shownRoutes: visible.length, totalRoutes: allRoutes.length,
    routePage: page, stale: !fresh }
}
