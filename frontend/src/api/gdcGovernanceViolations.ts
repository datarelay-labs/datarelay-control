import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const GOV = `${GDC_API_PREFIX}/governance`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type ViolationStatus = 'OPEN' | 'QUARANTINED' | 'RELEASED' | 'REPLAYED' | 'DISCARDED'
export type ViolationSeverity = 'HIGH' | 'MEDIUM' | 'LOW'
export type ViolationWindow = '24h' | '7d' | '30d'

export type GovernanceViolationEntry = {
  id: string
  policy_id: number | null
  policy_name: string
  stream_id: number
  stream_name: string
  event_time: string
  severity: ViolationSeverity
  reason: string
  status: ViolationStatus
  quarantine_event_id: number | null
}

export type GovernanceViolationListResponse = {
  window: ViolationWindow
  total: number
  violations: GovernanceViolationEntry[]
}

export type GovernanceViolationPolicySummary = {
  policy_id: number | null
  policy_name: string
  policy_status: string | null
  policy_version: number | null
  rule_summary: string | null
}

export type GovernanceViolationQuarantineRef = {
  quarantine_event_id: number
  status: string
  quarantine_reason: string
  created_at: string
  released_at: string | null
}

export type GovernanceViolationReplayRef = {
  replay_event_id: number
  status: string
  event_count: number
  last_replay_at: string | null
}

export type GovernanceViolationDetailResponse = {
  violation: GovernanceViolationEntry
  policy_summary: GovernanceViolationPolicySummary
  related_quarantine: GovernanceViolationQuarantineRef | null
  related_replays: GovernanceViolationReplayRef[]
}

export type ViolationListFilters = {
  window?: ViolationWindow
  policy_id?: number
  stream_id?: number
  severity?: ViolationSeverity
  status?: ViolationStatus
  limit?: number
}

function buildQuery(filters?: ViolationListFilters): string {
  const q = new URLSearchParams()
  if (filters?.window) q.set('window', filters.window)
  if (filters?.policy_id != null) q.set('policy_id', String(filters.policy_id))
  if (filters?.stream_id != null) q.set('stream_id', String(filters.stream_id))
  if (filters?.severity) q.set('severity', filters.severity)
  if (filters?.status) q.set('status', filters.status)
  if (filters?.limit != null) q.set('limit', String(filters.limit))
  const qs = q.toString()
  return qs ? `?${qs}` : ''
}

export async function fetchGovernanceViolations(
  filters?: ViolationListFilters,
): Promise<GovernanceViolationListResponse | null> {
  return safeRequestJson<GovernanceViolationListResponse>(
    `${GOV}/violations${buildQuery(filters)}`,
    readJsonOpts,
  )
}

export async function fetchGovernanceViolationDetail(
  violationId: string,
  window: ViolationWindow = '30d',
): Promise<GovernanceViolationDetailResponse | null> {
  return safeRequestJson<GovernanceViolationDetailResponse>(
    `${GOV}/violations/${encodeURIComponent(violationId)}?window=${window}`,
    readJsonOpts,
  )
}
