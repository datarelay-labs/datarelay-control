import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const GOV = `${GDC_API_PREFIX}/governance`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type QuarantineDisplayStatus = 'QUARANTINED' | 'RELEASED' | 'DISCARDED' | 'REPLAYED'
export type QuarantineSeverity = 'HIGH' | 'MEDIUM' | 'LOW'
export type QuarantineWindow = '24h' | '7d' | '30d'

export type GovernanceQuarantineEntry = {
  id: number
  policy_id: number | null
  policy_name: string
  stream_id: number
  stream_name: string
  classification: string | null
  severity: QuarantineSeverity
  reason: string
  status: QuarantineDisplayStatus
  quarantined_at: string
  violation_id: string | null
}

export type GovernanceQuarantineListResponse = {
  window: QuarantineWindow
  total: number
  quarantine_events: GovernanceQuarantineEntry[]
}

export type GovernanceQuarantinePolicySummary = {
  policy_id: number | null
  policy_name: string
  policy_status: string | null
  policy_version: number | null
  rule_summary: string | null
}

export type GovernanceQuarantineSensitiveFinding = {
  field_path: string
  sensitivity_class: string
  status: string
}

export type GovernanceQuarantineProtectionAction = {
  field_path: string
  sensitivity_class: string
  protection_mode: string
}

export type GovernanceQuarantinePolicyDecision = {
  action: string
  summary: string | null
}

export type GovernanceQuarantineReplayRef = {
  replay_event_id: number
  status: string
  event_count: number
  last_replay_at: string | null
}

export type GovernanceQuarantineViolationRef = {
  violation_id: string
  status: string
  reason: string
}

export type GovernanceQuarantineMetadata = {
  quarantine_event_id: number
  quarantine_source: string
  event_count: number
  created_at: string
  updated_at: string
  released_at: string | null
  released_by: string | null
}

export type GovernanceQuarantineRootCauseStrip = {
  detected: string
  action: string
  policy: string
  result: string
  summary: string
}

export type GovernanceQuarantineDetailResponse = {
  entry: GovernanceQuarantineEntry
  policy_summary: GovernanceQuarantinePolicySummary
  violation_reason: string
  classification: string | null
  sensitive_findings: GovernanceQuarantineSensitiveFinding[]
  protection_actions: GovernanceQuarantineProtectionAction[]
  policy_decision: GovernanceQuarantinePolicyDecision
  related_replay: GovernanceQuarantineReplayRef[]
  /** False when the Replay action cannot find a pending replay job (older servers omit it). */
  replay_available?: boolean
  replay_unavailable_reason?: string | null
  related_violation: GovernanceQuarantineViolationRef | null
  related_quarantine: GovernanceQuarantineMetadata
  quarantine_metadata: GovernanceQuarantineMetadata
  root_cause_strip: GovernanceQuarantineRootCauseStrip
}

export type GovernanceQuarantineBulkItemResult = {
  id: number
  outcome: string
  message: string
  status?: string | null
  replay_event_id?: number | null
}

export type GovernanceQuarantineBulkResponse = {
  total: number
  succeeded: number
  failed: number
  results: GovernanceQuarantineBulkItemResult[]
}

export type QuarantineListFilters = {
  window?: QuarantineWindow
  policy_id?: number
  stream_id?: number
  severity?: QuarantineSeverity
  classification?: string
  status?: QuarantineDisplayStatus
  limit?: number
}

function buildQuery(filters?: QuarantineListFilters): string {
  const q = new URLSearchParams()
  if (filters?.window) q.set('window', filters.window)
  if (filters?.policy_id != null) q.set('policy_id', String(filters.policy_id))
  if (filters?.stream_id != null) q.set('stream_id', String(filters.stream_id))
  if (filters?.severity) q.set('severity', filters.severity)
  if (filters?.classification) q.set('classification', filters.classification)
  if (filters?.status) q.set('status', filters.status)
  if (filters?.limit != null) q.set('limit', String(filters.limit))
  const qs = q.toString()
  return qs ? `?${qs}` : ''
}

export async function fetchGovernanceQuarantineEvents(
  filters?: QuarantineListFilters,
): Promise<GovernanceQuarantineListResponse | null> {
  return safeRequestJson<GovernanceQuarantineListResponse>(
    `${GOV}/quarantine${buildQuery(filters)}`,
    readJsonOpts,
  )
}

export async function fetchGovernanceQuarantineDetail(
  quarantineId: number,
  window: QuarantineWindow = '30d',
): Promise<GovernanceQuarantineDetailResponse | null> {
  return safeRequestJson<GovernanceQuarantineDetailResponse>(
    `${GOV}/quarantine/${quarantineId}?window=${window}`,
    readJsonOpts,
  )
}

export async function releaseGovernanceQuarantineEvents(
  ids: number[],
): Promise<GovernanceQuarantineBulkResponse> {
  return requestJson<GovernanceQuarantineBulkResponse>(`${GOV}/quarantine/release`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export async function discardGovernanceQuarantineEvents(
  ids: number[],
): Promise<GovernanceQuarantineBulkResponse> {
  return requestJson<GovernanceQuarantineBulkResponse>(`${GOV}/quarantine/discard`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export async function replayGovernanceQuarantineEvents(
  ids: number[],
): Promise<GovernanceQuarantineBulkResponse> {
  return requestJson<GovernanceQuarantineBulkResponse>(`${GOV}/quarantine/replay`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}
