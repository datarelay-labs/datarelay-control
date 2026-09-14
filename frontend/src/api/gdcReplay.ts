import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type ReplayEventStatus = 'pending' | 'replaying' | 'replayed' | 'failed' | 'discarded'

export type ReplayEventItem = {
  id: number
  stream_id: number
  destination_id: number
  route_id: number | null
  dynamic_route_id: number | null
  failover_route_id: number | null
  delivery_kind: string
  status: ReplayEventStatus
  error_type: string | null
  error_message: string | null
  retry_count: number
  event_count: number
  created_at: string
  updated_at: string
  last_replay_at: string | null
  attempt_id?: string | null
  idempotency_key?: string | null
  delivery_guarantee?: string | null
  prior_delivery_uncertain?: boolean | null
  claimed_at?: string | null
}

export type StreamReplayEventsResponse = {
  stream_id: number
  events: ReplayEventItem[]
  event_count: number
}

export type StreamReplaySummaryResponse = {
  stream_id: number
  pending_count: number
  replaying_count?: number
  replayed_count: number
  failed_count: number
  discarded_count: number
  total_count: number
  last_recorded_at: string | null
}

export type ReplayEventActionResponse = {
  id: number
  stream_id: number
  destination_id: number
  route_id: number | null
  status: ReplayEventStatus
  retry_count: number
  outcome: string
  message: string
  attempt_id?: string | null
  idempotency_key?: string | null
  delivery_guarantee?: string | null
  prior_delivery_uncertain?: boolean | null
}

export async function fetchStreamReplayEvents(
  streamId: number,
  status?: ReplayEventStatus,
  limit = 50,
): Promise<StreamReplayEventsResponse | null> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  q.set('limit', String(limit))
  const qs = q.toString()
  return safeRequestJson<StreamReplayEventsResponse>(
    `${RT}/streams/${streamId}/replay-events?${qs}`,
    readJsonOpts,
  )
}

export async function fetchStreamReplaySummary(
  streamId: number,
  options?: GdcSignalOptions,
): Promise<StreamReplaySummaryResponse | null> {
  return safeRequestJson<StreamReplaySummaryResponse>(
    `${RT}/streams/${streamId}/replay/summary`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function replayStreamReplayEvent(eventId: number): Promise<ReplayEventActionResponse> {
  return requestJson<ReplayEventActionResponse>(`${RT}/replay-events/${eventId}/replay`, {
    method: 'POST',
  })
}

export async function discardStreamReplayEvent(eventId: number): Promise<ReplayEventActionResponse> {
  return requestJson<ReplayEventActionResponse>(`${RT}/replay-events/${eventId}/discard`, {
    method: 'POST',
  })
}
