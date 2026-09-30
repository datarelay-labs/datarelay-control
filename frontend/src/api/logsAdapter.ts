import type { LogExplorerRow, LogLevel } from '../components/logs/logs-types'
import type { RuntimeLogSearchItem } from './types/gdcApi'

export type LogEntityLabelMaps = {
  streams: Map<number, string>
  routes: Map<number, string>
  destinations: Map<number, string>
  connectors: Map<number, string>
}

function normalizeLevel(raw: string): LogLevel {
  const u = raw.toUpperCase()
  if (u === 'ERROR') return 'ERROR'
  if (u === 'WARN' || u === 'WARNING') return 'WARN'
  if (u === 'DEBUG') return 'DEBUG'
  return 'INFO'
}

function safeNonNegInt(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return Math.floor(x)
}

function routeDestinationLabel(routeId: unknown, destinationId: unknown): string {
  const rid = safeNonNegInt(routeId)
  const did = safeNonNegInt(destinationId)
  if (rid > 0 && did > 0) return `Route #${rid} -> Destination #${did}`
  if (rid > 0) return `Route #${rid}`
  if (did > 0) return `Destination #${did}`
  return '—'
}

/** Maps runtime delivery_logs row into the logs explorer table shape. */
export function runtimeLogSearchItemToExplorerRow(log: RuntimeLogSearchItem): LogExplorerRow {
  const latencyMs = safeNonNegInt(log.latency_ms)
  return {
    id: `log-${log.id}`,
    eventId: `evt_${log.id}`,
    requestId: log.run_id ?? undefined,
    timeIso: log.created_at,
    level: normalizeLevel(log.level),
    connector: log.connector_id != null ? `Connector #${log.connector_id}` : '—',
    stream: log.stream_id != null ? `Stream #${log.stream_id}` : '—',
    route: routeDestinationLabel(log.route_id, log.destination_id),
    pipelineStage: log.stage,
    message: log.message,
    durationMs: latencyMs,
    contextJson: {
      stage: log.stage,
      status: log.status,
      error_code: log.error_code,
      stream_id: log.stream_id,
      route_id: log.route_id,
      destination_id: log.destination_id,
      connector_id: log.connector_id,
      retry_count: log.retry_count,
      http_status: log.http_status,
      latency_ms: log.latency_ms,
      log_db_id: log.id,
      run_id: log.run_id,
      batch_id: log.batch_id,
      policy_action: log.policy_action,
      decision_reason: log.decision_reason,
      delivery_disposition: log.delivery_disposition,
      skip_reason: log.skip_reason,
      quarantine_event_id: log.quarantine_event_id,
    },
    relatedEventId: null,
  }
}

export function enrichLogExplorerRows(rows: readonly LogExplorerRow[], labels: LogEntityLabelMaps): LogExplorerRow[] {
  return rows.map((row) => {
    const sid = typeof row.contextJson.stream_id === 'number' ? row.contextJson.stream_id : null
    const cid = typeof row.contextJson.connector_id === 'number' ? row.contextJson.connector_id : null
    const rid = typeof row.contextJson.route_id === 'number' ? row.contextJson.route_id : null
    const did = typeof row.contextJson.destination_id === 'number' ? row.contextJson.destination_id : null
    const stream = sid != null ? labels.streams.get(sid) ?? `Stream #${sid}` : row.stream
    const connector = cid != null ? labels.connectors.get(cid) ?? `Connector #${cid}` : row.connector
    const routeName = rid != null ? labels.routes.get(rid) ?? `Route #${rid}` : null
    const destName = did != null ? labels.destinations.get(did) ?? `Destination #${did}` : null
    const route =
      routeName != null && destName != null
        ? `${routeName} → ${destName}`
        : routeName != null
          ? routeName
          : row.route
    return { ...row, stream, connector, route }
  })
}

/** @deprecated Use runtimeLogSearchItemToExplorerRow */
export const runtimeLogSearchItemToMockRow = runtimeLogSearchItemToExplorerRow
