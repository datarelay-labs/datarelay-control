import { fetchRuntimeRunTrace, runStreamOnce } from '../../../api/gdcRuntime'
import type { RuntimeTraceResponse, RuntimeTraceTimelineEntry } from '../../../api/types/gdcApi'
import {
  deliveryEvidenceScope,
  evaluateExactRunDelivery,
  type DeliveryEvidenceRow,
  type ExactRunDeliveryProof,
  type PriorDeliveryProof,
  type RunDeliveryAggregates,
} from './deploy-delivery-proof'

/**
 * Map a full run trace into exact-run evidence.
 * Destination attribution prefers an earlier exact-run destination on the same route.
 * Current route config is not exact-run destination proof.
 * Failover uses the secondary destination recorded on the run log when present.
 */
export function evidenceFromRuntimeTrace(
  trace: Pick<RuntimeTraceResponse, 'timeline'>,
): DeliveryEvidenceRow[] {
  const ordered = [...trace.timeline].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
  const lastExactDestination = new Map<number, number>()
  const rows: DeliveryEvidenceRow[] = []
  for (const entry of ordered) {
    const mapped = evidenceRowFromTimelineEntry(entry, lastExactDestination)
    if (mapped) rows.push(mapped)
  }
  return rows
}

function evidenceRowFromTimelineEntry(
  entry: RuntimeTraceTimelineEntry,
  lastExactDestination: Map<number, number>,
): DeliveryEvidenceRow | null {
  const stage = entry.stage.trim()
  const scope = deliveryEvidenceScope(stage)
  if (scope == null) return null
  if (scope === 'failover') {
    const secondaryId = entry.secondary_destination_id ?? null
    return {
      route_id: entry.route_id,
      destination_id: secondaryId,
      destination_label: secondaryId == null ? 'secondary destination unknown' : `destination ${secondaryId}`,
      stage,
      skip_reason: entry.skip_reason ?? null,
      created_at: entry.created_at,
      sequence: entry.id,
      scope,
    }
  }
  if (scope === 'dynamic') {
    const destinationId = entry.destination_id
    return {
      route_id: null,
      dynamic_route_id: entry.dynamic_route_id ?? null,
      destination_id: destinationId,
      destination_label:
        entry.dynamic_route_id == null
          ? destinationId == null
            ? 'dynamic target'
            : `dynamic target ${destinationId}`
          : `dynamic route ${entry.dynamic_route_id}`,
      stage,
      skip_reason: entry.skip_reason ?? null,
      created_at: entry.created_at,
      sequence: entry.id,
      scope,
    }
  }

  let destinationId = entry.destination_id
  if (destinationId != null && entry.route_id != null) {
    lastExactDestination.set(entry.route_id, destinationId)
  } else if (destinationId == null && entry.route_id != null) {
    const exact = lastExactDestination.get(entry.route_id)
    if (exact != null) destinationId = exact
  }
  return {
    route_id: entry.route_id,
    destination_id: destinationId,
    destination_label: destinationId == null ? 'destination unavailable' : `destination ${destinationId}`,
    stage,
    skip_reason: entry.skip_reason ?? null,
    created_at: entry.created_at,
    sequence: entry.id,
    scope,
  }
}

function aggregatesFromRun(response: {
  route_delivery_success_count?: number | null
  route_delivery_failure_count?: number | null
  route_delivery_blocked_count?: number | null
  route_delivery_review_count?: number | null
  route_delivery_quarantine_count?: number | null
  route_delivery_attempt_count?: number | null
}): RunDeliveryAggregates {
  return {
    successCount: response.route_delivery_success_count,
    failureCount: response.route_delivery_failure_count,
    blockedCount: response.route_delivery_blocked_count,
    reviewCount: response.route_delivery_review_count,
    quarantineCount: response.route_delivery_quarantine_count,
    attemptCount: response.route_delivery_attempt_count,
  }
}

/** Command accepted is not delivery proven. Proof uses the full exact-run trace, not a capped log search. */
export async function proveStreamRunOnce(
  streamId: number,
  prior: PriorDeliveryProof | null,
): Promise<ExactRunDeliveryProof> {
  const response = await runStreamOnce(streamId)
  const runtimeRunId = response.runtime_run_id?.trim() || null
  const aggregates = aggregatesFromRun(response)
  if (runtimeRunId == null) {
    return evaluateExactRunDelivery({
      streamId,
      runtimeRunId: null,
      commandAccepted: true,
      evidence: [],
      prior,
      aggregates,
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
      aggregates,
    })
  }

  return evaluateExactRunDelivery({
    streamId,
    runtimeRunId,
    commandAccepted: true,
    evidence: evidenceFromRuntimeTrace(trace),
    prior,
    aggregates,
  })
}
