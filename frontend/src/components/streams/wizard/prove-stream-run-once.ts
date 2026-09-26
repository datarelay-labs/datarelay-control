import type { FailoverRoute } from '../../../api/gdcFailoverRouting'
import { fetchStreamFailoverRoutes } from '../../../api/gdcFailoverRouting'
import { fetchRuntimeRunTrace, runStreamOnce } from '../../../api/gdcRuntime'
import type { RuntimeTraceResponse, RuntimeTraceTimelineEntry } from '../../../api/types/gdcApi'
import {
  DELIVERY_FAILURE_STAGES,
  DELIVERY_SUCCESS_STAGES,
  evaluateExactRunDelivery,
  type DeliveryEvidenceRow,
  type DeliveryEvidenceScope,
  type ExactRunDeliveryProof,
  type PriorDeliveryProof,
} from './deploy-delivery-proof'

function stageScope(stage: string): DeliveryEvidenceScope | null {
  if (stage.startsWith('failover_route_send_')) return 'failover'
  if (stage.startsWith('dynamic_route_send_')) return 'dynamic'
  if (DELIVERY_SUCCESS_STAGES.has(stage) || DELIVERY_FAILURE_STAGES.has(stage)) return 'route'
  return null
}

/** Map a full run trace into exact-run evidence. Failover success is attributed to the secondary destination. */
export function evidenceFromRuntimeTrace(
  trace: Pick<RuntimeTraceResponse, 'timeline' | 'routes'>,
  failoverRoutes: FailoverRoute[],
): DeliveryEvidenceRow[] {
  const ordered = [...trace.timeline].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
  const rows: DeliveryEvidenceRow[] = []
  for (const entry of ordered) {
    const mapped = evidenceRowFromTimelineEntry(entry, trace.routes, failoverRoutes)
    if (mapped) rows.push(mapped)
  }
  return rows
}

function evidenceRowFromTimelineEntry(
  entry: RuntimeTraceTimelineEntry,
  traceRoutes: RuntimeTraceResponse['routes'],
  failoverRoutes: FailoverRoute[],
): DeliveryEvidenceRow | null {
  const stage = entry.stage.trim()
  const scope = stageScope(stage)
  if (scope == null) return null
  if (scope === 'failover') {
    const primaryId = traceRoutes.find((route) => route.id === entry.route_id)?.destination_id ?? null
    const match =
      primaryId == null ? null : failoverRoutes.find((route) => route.primary_destination_id === primaryId) ?? null
    return {
      route_id: entry.route_id,
      destination_id: match?.secondary_destination_id ?? null,
      destination_label: match
        ? match.secondary_destination_name?.trim() || `destination ${match.secondary_destination_id}`
        : 'secondary destination unknown',
      stage,
      created_at: entry.created_at,
      sequence: entry.id,
      scope,
    }
  }
  if (scope === 'dynamic') {
    return {
      route_id: entry.route_id,
      destination_id: entry.destination_id,
      destination_label: 'dynamic target',
      stage,
      created_at: entry.created_at,
      sequence: entry.id,
      scope,
    }
  }
  return {
    route_id: entry.route_id,
    destination_id: entry.destination_id,
    destination_label: entry.destination_id == null ? 'destination unavailable' : `destination ${entry.destination_id}`,
    stage,
    created_at: entry.created_at,
    sequence: entry.id,
    scope,
  }
}

/** Command accepted is not delivery proven. Proof uses the full exact-run trace, not a capped log search. */
export async function proveStreamRunOnce(
  streamId: number,
  prior: PriorDeliveryProof | null,
): Promise<ExactRunDeliveryProof> {
  const response = await runStreamOnce(streamId)
  const runtimeRunId = response.runtime_run_id?.trim() || null
  if (runtimeRunId == null) {
    return evaluateExactRunDelivery({
      streamId,
      runtimeRunId: null,
      commandAccepted: true,
      evidence: [],
      prior,
    })
  }
  const trace = await fetchRuntimeRunTrace(runtimeRunId)
  const traceRunId = trace?.run_id?.trim() || null
  if (trace == null || traceRunId !== runtimeRunId || (trace.stream_id != null && trace.stream_id !== streamId)) {
    return evaluateExactRunDelivery({
      streamId,
      runtimeRunId,
      commandAccepted: true,
      evidence: null,
      prior,
    })
  }
  const needsFailover = trace.timeline.some((entry) => entry.stage.startsWith('failover_route_send_'))
  const failover = needsFailover ? await fetchStreamFailoverRoutes(streamId) : null
  return evaluateExactRunDelivery({
    streamId,
    runtimeRunId,
    commandAccepted: true,
    evidence: evidenceFromRuntimeTrace(trace, failover?.routes ?? []),
    prior,
  })
}
