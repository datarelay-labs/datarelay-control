import { Activity, ArrowUpRight, CircleAlert, Gauge, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Edge, Node } from '@xyflow/react'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { routeEditPath } from '../../config/nav-paths'
import { formatFlowRate } from './runtime-flow-format'
import type { FlowEdgeData, FlowNodeData } from './runtime-flow-graph-model'

type Props = {
  snapshot: OperationalSnapshotResponse
  selectedStreamId: number
  selectedNode?: Node<FlowNodeData>
  selectedEdge?: Edge<FlowEdgeData>
  shownRoutes: number
  totalRoutes: number
  stale: boolean
  /** When embedded in a Route workspace, select locally without losing drafts. */
  onInspectRoute?: (routeId: number) => void
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value.toFixed(1) + '%' : '—'
}

function formatLatency(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value) + ' ms' : '—'
}

export function RuntimeFlowInspector({
  snapshot, selectedStreamId, selectedNode, selectedEdge, shownRoutes, totalRoutes, stale, onInspectRoute,
}: Props) {
  const nodeRoute = selectedNode?.data.kind === 'route'
    ? Number(selectedNode.id.slice('route:'.length)) : null
  const routeId = selectedEdge?.data?.routeId ?? nodeRoute
  const route = routeId != null
    ? snapshot.routes.find((candidate) => candidate.route_id === routeId && candidate.stream_id === selectedStreamId)
    : undefined
  const stream = snapshot.streams.find((candidate) => candidate.stream_id === selectedStreamId)
  const destination = route
    ? snapshot.destinations.find((candidate) => candidate.destination_id === route.destination_id)
    : undefined
  const selectionLabel = route ? 'Route #' + route.route_id
    : selectedNode?.data.label ?? (selectedEdge ? 'Data path' : 'Flow overview')
  const status = stale ? 'Unknown · last reported'
    : route ? (route.enabled ? route.health_status : 'Disabled')
      : selectedNode?.data.status ?? (stream?.health_status ?? 'Unknown')
  const rate = route ? route.delivered_eps_1m : stream?.eps_1m ?? null
  const rateBasis = route ? 'Gateway delivery · 1 min' : 'Stream ingest · 1 min'
  const detail = selectedEdge?.data?.evidence ?? selectedNode?.data.detail
  return (
    <aside className="control-runtime-flow-inspector" aria-label="Selected flow details"
      data-testid="runtime-data-flow-inspector">
      <div className="control-runtime-flow-inspector-head">
        <span className="control-runtime-flow-inspector-eyebrow">FLOW INSPECTOR</span>
        <span className="control-runtime-flow-inspector-status">
          <span className="control-runtime-flow-inspector-status-dot" aria-hidden="true" />
          {status}
        </span>
      </div>
      {selectedEdge ? (
        <p className="control-runtime-flow-inspector-eyebrow">Selected delivery relation</p>
      ) : null}
      <h4 className="control-runtime-flow-inspector-title">{selectionLabel}</h4>
      <p className="control-runtime-flow-inspector-description">
        {detail ?? (totalRoutes + ' Route paths · ' + shownRoutes + ' shown. Select a node or path to inspect it.')}
      </p>
      <div className="control-runtime-flow-inspector-stats">
        <div className="control-runtime-flow-inspector-stat">
          <Activity aria-hidden="true" size={17} />
          <div>
            <span>{rateBasis}{stale ? ' · last reported' : ''}</span>
            <strong>{formatFlowRate(rate)} <small>evt/s</small></strong>
          </div>
        </div>
        <div className="control-runtime-flow-inspector-stat">
          <ShieldCheck aria-hidden="true" size={17} />
          <div>
            <span>Delivery success · 5 min</span>
            <strong>{route ? formatPercent(route.success_rate_5m) : '—'}</strong>
          </div>
        </div>
        <div className="control-runtime-flow-inspector-stat">
          <Gauge aria-hidden="true" size={17} />
          <div>
            <span>Route average latency</span>
            <strong>{route ? formatLatency(route.avg_latency_ms) : '—'}</strong>
          </div>
        </div>
      </div>
      {route ? (
        <div className="control-runtime-flow-inspector-route">
          <span className="control-runtime-flow-inspector-eyebrow">DESTINATION</span>
          <strong>{route.destination_name || destination?.destination_name || 'Not configured'}</strong>
          <span>{stale ? 'Last reported' : (destination?.health_status ?? 'Status unavailable')} · receiver receipt not verified</span>
          {route.last_error_message ? (
            <p className="control-runtime-flow-inspector-error"><CircleAlert size={14} aria-hidden="true" />
              {route.last_error_message}</p>
          ) : null}
          {onInspectRoute ? (
            <button type="button" className="control-runtime-flow-inspector-link"
              onClick={() => onInspectRoute(route.route_id)}>
              Inspect in workspace <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ) : (
            <Link to={routeEditPath(String(route.route_id))} className="control-runtime-flow-inspector-link">
              Inspect Route <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          )}
        </div>
      ) : selectedNode?.data.href ? (
        <Link to={selectedNode.data.href} className="control-runtime-flow-inspector-link">
          Open details <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      ) : (
        <p className="control-runtime-flow-inspector-hint">Select a Route to inspect observed delivery and diagnostics.</p>
      )}
      <p className="control-runtime-flow-inspector-footnote">
        Gateway metrics describe aggregated runtime observations, not individual packets or confirmed receiver receipt.
      </p>
    </aside>
  )
}
