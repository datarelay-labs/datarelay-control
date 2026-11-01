import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const GOV = `${GDC_API_PREFIX}/governance`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type ApprovalEventType =
  | 'SUBMITTED_FOR_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'REQUEST_CHANGES'
  | 'ACTIVATED'
  | 'CANCELLED'

export type ApprovalWindow = '24h' | '7d' | '30d'
export type PolicyStatus = 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'RETIRED'

export type GovernanceApprovalQueueEntry = {
  policy_id: number
  policy_name: string
  policy_status: PolicyStatus
  approval_status: string
  requester: string | null
  reviewer: string | null
  submitted_at: string | null
  last_action: ApprovalEventType | null
  last_action_at: string | null
  last_comment: string | null
  impact_label: string | null
}

export type GovernanceApprovalListResponse = {
  window: ApprovalWindow
  total: number
  approvals: GovernanceApprovalQueueEntry[]
}

export type GovernanceApprovalHistoryEntry = {
  event_time: string
  event_type: ApprovalEventType
  actor: string
  comment: string | null
}

export type GovernanceApprovalPolicySummary = {
  id: number
  name: string
  description: string | null
  category: string
  status: PolicyStatus
  version: number
  assigned_stream_count: number
  assigned_stream_ids: number[]
}

export type GovernanceApprovalImpactSummary = {
  impact_data_available: boolean
  impact_matched_events: number | null
  impact_summary: Record<string, unknown> | null
  affected_stream_count: number
}

export type GovernanceApprovalSimulationSummary = {
  simulation_available: boolean
  dry_run_summary: string | null
  action_breakdown: Record<string, number>
}

export type GovernanceApprovalDetailResponse = {
  policy: GovernanceApprovalPolicySummary
  current_status: PolicyStatus
  approval_status: string
  requester: string | null
  reviewer: string | null
  submitted_at: string | null
  review_comment: string | null
  is_approved: boolean
  history: GovernanceApprovalHistoryEntry[]
  impact: GovernanceApprovalImpactSummary | null
  simulation: GovernanceApprovalSimulationSummary | null
}

export type GovernanceApprovalActionResponse = {
  policy_id: number
  policy_status: PolicyStatus
  approval_status: string
  event_type: ApprovalEventType
  message: string
}

export async function fetchGovernanceApprovals(params: {
  window?: ApprovalWindow
  policy_id?: number
  status?: string
  requester?: string
  reviewer?: string
  limit?: number
}): Promise<GovernanceApprovalListResponse> {
  const qs = new URLSearchParams()
  if (params.window) qs.set('window', params.window)
  if (params.policy_id != null) qs.set('policy_id', String(params.policy_id))
  if (params.status) qs.set('status', params.status)
  if (params.requester) qs.set('requester', params.requester)
  if (params.reviewer) qs.set('reviewer', params.reviewer)
  if (params.limit != null) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const data = await safeRequestJson<GovernanceApprovalListResponse>(`${GOV}/approvals${suffix}`, readJsonOpts)
  return data ?? { window: params.window ?? '24h', total: 0, approvals: [] }
}

export async function fetchGovernanceApprovalDetail(
  policyId: number,
): Promise<GovernanceApprovalDetailResponse | null> {
  return safeRequestJson<GovernanceApprovalDetailResponse>(`${GOV}/approvals/${policyId}`, readJsonOpts)
}

/** Error code the API returns (HTTP 403) when the submitter approves or activates their own policy (F-187). */
export const SELF_APPROVAL_FORBIDDEN_CODE = 'GOVERNANCE_SELF_APPROVAL_FORBIDDEN'

export type SelfApprovalOptions = {
  /** Explicit override of the separation-of-duties rule; only sent as `true` after the user confirmed. */
  allowSelfApproval?: boolean
}

export function errorIndicatesSelfApprovalForbidden(err: unknown): boolean {
  return err instanceof Error && err.message.includes(SELF_APPROVAL_FORBIDDEN_CODE)
}

async function postApprovalAction(
  policyId: number,
  action: 'submit' | 'approve' | 'reject' | 'activate',
  comment?: string | null,
  options?: SelfApprovalOptions,
): Promise<GovernanceApprovalActionResponse> {
  return requestJson<GovernanceApprovalActionResponse>(`${GOV}/approvals/${policyId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({
      comment: comment ?? null,
      ...(options?.allowSelfApproval === true ? { allow_self_approval: true } : {}),
    }),
  })
}

export function submitGovernanceApproval(policyId: number, comment?: string | null) {
  return postApprovalAction(policyId, 'submit', comment)
}

export function approveGovernancePolicy(policyId: number, comment?: string | null, options?: SelfApprovalOptions) {
  return postApprovalAction(policyId, 'approve', comment, options)
}

export function rejectGovernancePolicy(policyId: number, comment?: string | null) {
  return postApprovalAction(policyId, 'reject', comment)
}

export function activateGovernanceApproval(policyId: number, comment?: string | null, options?: SelfApprovalOptions) {
  return postApprovalAction(policyId, 'activate', comment, options)
}
