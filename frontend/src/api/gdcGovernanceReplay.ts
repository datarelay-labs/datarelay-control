import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const GOV = `${GDC_API_PREFIX}/governance`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type ReplayDisplayStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DISCARDED'
export type ReplayWindow = '24h' | '7d' | '30d'
export type ReplayOutcomeLabel = 'Success' | 'Failure' | 'Discarded'

export type GovernanceReplayEntry = {
  id: number
  policy_id: number | null
  policy_name: string
  stream_id: number
  stream_name: string
  status: ReplayDisplayStatus
  created_at: string
  completed_at: string | null
  outcome: ReplayOutcomeLabel | null
  event_count: number
  correlation_id: string | null
  route_id?: number | null
  destination_id?: number | null
  /** Failed polls folded into this job (one job per Stream/Route/event set). */
  occurrence_count?: number
  /** Explains a non-obvious state, e.g. why a Discarded job was superseded. */
  status_note?: string | null
}

export type GovernanceReplayListResponse = {
  window: ReplayWindow
  total: number
  replay_events: GovernanceReplayEntry[]
  queue_count: number
  failed_count: number
  recent_count: number
}

export type GovernanceReplayPolicySummary = {
  policy_id: number | null
  policy_name: string
  policy_status: string | null
  policy_version: number | null
}

export type GovernanceReplayViolationRef = {
  violation_id: string
  status: string
  reason: string
}

export type GovernanceReplayQuarantineRef = {
  quarantine_event_id: number
  status: string
  quarantine_reason: string
  created_at: string
}

export type GovernanceReplaySource = {
  origin: string
  violation: GovernanceReplayViolationRef | null
  quarantine: GovernanceReplayQuarantineRef | null
}

export type GovernanceReplayTimelineStep = {
  step: string
  label: string
  event_time: string | null
}

export type GovernanceReplayDetailResponse = {
  entry: GovernanceReplayEntry
  policy_summary: GovernanceReplayPolicySummary
  correlation_id: string | null
  source: GovernanceReplaySource
  timeline: GovernanceReplayTimelineStep[]
  outcome: ReplayOutcomeLabel | null
  error_type: string | null
  error_message: string | null
  can_execute: boolean
  can_discard?: boolean
}

export type GovernanceReplayBulkItemResult = {
  id: number
  outcome: string
  message: string
  status?: string | null
  error_code?: string | null
}

/** The events of this job were already delivered; replaying again needs an explicit override. */
export const REPLAY_ALREADY_DELIVERED_CODE = 'REPLAY_ALREADY_DELIVERED'

export type ReplayExecuteOptions = {
  /** Explicit operator override: replay even though the events were already delivered. */
  allowRedelivery?: boolean
}

export type GovernanceReplayBulkResponse = {
  total: number
  succeeded: number
  failed: number
  results: GovernanceReplayBulkItemResult[]
}

export type ReplayListFilters = {
  window?: ReplayWindow
  policy_id?: number
  stream_id?: number
  status?: ReplayDisplayStatus
  limit?: number
}

function buildQuery(filters?: ReplayListFilters): string {
  const q = new URLSearchParams()
  if (filters?.window) q.set('window', filters.window)
  if (filters?.policy_id != null) q.set('policy_id', String(filters.policy_id))
  if (filters?.stream_id != null) q.set('stream_id', String(filters.stream_id))
  if (filters?.status) q.set('status', filters.status)
  if (filters?.limit != null) q.set('limit', String(filters.limit))
  const qs = q.toString()
  return qs ? `?${qs}` : ''
}

export async function fetchGovernanceReplayEvents(
  filters?: ReplayListFilters,
): Promise<GovernanceReplayListResponse | null> {
  return safeRequestJson<GovernanceReplayListResponse>(`${GOV}/replay${buildQuery(filters)}`, readJsonOpts)
}

export async function fetchGovernanceReplayDetail(
  replayId: number,
  window: ReplayWindow = '30d',
): Promise<GovernanceReplayDetailResponse | null> {
  return safeRequestJson<GovernanceReplayDetailResponse>(`${GOV}/replay/${replayId}?window=${window}`, readJsonOpts)
}

export type GovernanceReplayExecuteResponse = {
  id: number
  outcome: string
  message: string
  status?: string | null
  error_code?: string | null
}

export async function executeGovernanceReplay(
  replayId: number,
  options: ReplayExecuteOptions = {},
): Promise<GovernanceReplayExecuteResponse> {
  return requestJson<GovernanceReplayExecuteResponse>(`${GOV}/replay/${replayId}/execute`, {
    method: 'POST',
    body: JSON.stringify(options.allowRedelivery ? { allow_redelivery: true } : {}),
  })
}

export async function bulkExecuteGovernanceReplay(
  ids: number[],
  options: ReplayExecuteOptions = {},
): Promise<GovernanceReplayBulkResponse> {
  return requestJson<GovernanceReplayBulkResponse>(`${GOV}/replay/bulk-execute`, {
    method: 'POST',
    body: JSON.stringify(options.allowRedelivery ? { ids, allow_redelivery: true } : { ids }),
  })
}

/** Discard (cancel) open replay jobs; nothing is delivered. */
export async function discardGovernanceReplay(replayId: number): Promise<GovernanceReplayExecuteResponse> {
  return requestJson<GovernanceReplayExecuteResponse>(`${GOV}/replay/${replayId}/discard`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function bulkDiscardGovernanceReplay(ids: number[]): Promise<GovernanceReplayBulkResponse> {
  return requestJson<GovernanceReplayBulkResponse>(`${GOV}/replay/bulk-discard`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}
