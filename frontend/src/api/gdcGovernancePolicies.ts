import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const GOV = `${GDC_API_PREFIX}/governance`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type PolicyStatus = 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'RETIRED'
export type PolicyCategory = 'DATA_PROTECTION' | 'AI_GOVERNANCE' | 'COMPLIANCE' | 'CUSTOM'
export type ConditionOperator = 'equals' | 'not_equals' | 'contains'
export type PolicyActionType = 'quarantine' | 'tokenize' | 'mask' | 'audit_only'

export type PolicyCondition = {
  field: string
  operator: ConditionOperator
  value: string
}

export type PolicyAction = {
  type: PolicyActionType
}

export type PolicyJsonBody = {
  conditions: PolicyCondition[]
  actions: PolicyAction[]
}

export type PolicyImpactDelta = {
  matched_events_change: number | null
}

export type PolicyImpactStreamEntry = {
  stream_id: number
  stream_name: string
  total_events: number
  matched_events: number
}

export type GovernancePolicyImpactResponse = {
  window: string
  total_events: number
  matched_events: number
  actions: Record<string, number>
  streams: PolicyImpactStreamEntry[]
  delta: PolicyImpactDelta
  data_available: boolean
}

export type GovernancePolicyEntry = {
  id: number
  name: string
  description: string | null
  category: PolicyCategory
  status: PolicyStatus
  policy_json: PolicyJsonBody
  version: number
  assigned_stream_count: number
  assigned_stream_ids: number[]
  impact_matched_events?: number | null
  impact_data_available?: boolean
  impact_summary?: string | null
  activated_at?: string | null
  retired_at?: string | null
  created_at: string
  updated_at: string
}

export type StreamAssignmentEntry = {
  stream_id: number
  enabled: boolean
}

export type PolicyPreviewRuleLine = {
  condition_text: string
  action_text: string
  combined: string
}

export type GovernancePolicyPreviewResponse = {
  policy_id: number
  policy_json: PolicyJsonBody
  rules: PolicyPreviewRuleLine[]
  summary: string
}

export async function fetchGovernancePolicies(): Promise<{ policies: GovernancePolicyEntry[] } | null> {
  return safeRequestJson<{ policies: GovernancePolicyEntry[] }>(`${GOV}/policies`, readJsonOpts)
}

export async function fetchGovernancePolicy(
  policyId: number,
): Promise<{ policy: GovernancePolicyEntry } | null> {
  return safeRequestJson<{ policy: GovernancePolicyEntry }>(`${GOV}/policies/${policyId}`, readJsonOpts)
}

export async function createGovernancePolicy(body: {
  name: string
  description?: string | null
  category?: PolicyCategory
  status?: PolicyStatus
  policy_json: PolicyJsonBody
}): Promise<{ policy: GovernancePolicyEntry } | null> {
  return requestJson(`${GOV}/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function updateGovernancePolicy(
  policyId: number,
  body: {
    name?: string
    description?: string | null
    category?: PolicyCategory
    status?: PolicyStatus
    policy_json?: PolicyJsonBody
  },
): Promise<{ policy: GovernancePolicyEntry } | null> {
  return requestJson(`${GOV}/policies/${policyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteGovernancePolicy(policyId: number): Promise<boolean> {
  const res = await fetch(`${GOV}/policies/${policyId}`, { method: 'DELETE', credentials: 'include' })
  return res.status === 204
}

export async function submitPolicyForReview(
  policyId: number,
): Promise<{ policy: GovernancePolicyEntry } | null> {
  return requestJson(`${GOV}/policies/${policyId}/submit-review`, { method: 'POST' })
}

export async function activateGovernancePolicy(
  policyId: number,
  options?: { allowSelfApproval?: boolean },
): Promise<{ policy: GovernancePolicyEntry } | null> {
  // F-187: `allow_self_approval: true` is only sent after the user confirmed the override dialog.
  if (options?.allowSelfApproval === true) {
    return requestJson(`${GOV}/policies/${policyId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allow_self_approval: true }),
    })
  }
  return requestJson(`${GOV}/policies/${policyId}/activate`, { method: 'POST' })
}

export async function retireGovernancePolicy(
  policyId: number,
): Promise<{ policy: GovernancePolicyEntry } | null> {
  return requestJson(`${GOV}/policies/${policyId}/retire`, { method: 'POST' })
}

export async function fetchPolicyAssignments(
  policyId: number,
): Promise<{ policy_id: number; assignments: StreamAssignmentEntry[] } | null> {
  return safeRequestJson<{ policy_id: number; assignments: StreamAssignmentEntry[] }>(
    `${GOV}/policies/${policyId}/assignments`,
    readJsonOpts,
  )
}

export async function updatePolicyAssignments(
  policyId: number,
  assignments: StreamAssignmentEntry[],
): Promise<{ policy_id: number; assignments: StreamAssignmentEntry[] } | null> {
  return requestJson(`${GOV}/policies/${policyId}/assignments`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments }),
  })
}

export async function fetchPolicyPreview(
  policyId: number,
): Promise<GovernancePolicyPreviewResponse | null> {
  return safeRequestJson<GovernancePolicyPreviewResponse>(
    `${GOV}/policies/${policyId}/preview`,
    readJsonOpts,
  )
}

export async function previewPolicyJson(
  policyJson: PolicyJsonBody,
): Promise<GovernancePolicyPreviewResponse | null> {
  return requestJson(`${GOV}/policies/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policyJson),
  })
}

export async function fetchPolicyImpact(
  policyId: number,
): Promise<GovernancePolicyImpactResponse | null> {
  return safeRequestJson<GovernancePolicyImpactResponse>(
    `${GOV}/policies/${policyId}/impact`,
    readJsonOpts,
  )
}

export async function previewPolicyImpact(body: {
  policy_json: PolicyJsonBody
  policy_id?: number | null
  stream_ids?: number[]
}): Promise<GovernancePolicyImpactResponse | null> {
  return requestJson(`${GOV}/policies/impact-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type PolicySimulationEventResult = {
  matched: boolean
  actions: string[]
  reason: string
}

export type GovernancePolicySimulateResponse = {
  events: PolicySimulationEventResult[]
}

export async function simulatePolicy(body: {
  policy_json: PolicyJsonBody
  sample_events?: Record<string, unknown>[]
  stream_ids?: number[]
}): Promise<GovernancePolicySimulateResponse | null> {
  return requestJson(`${GOV}/policies/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function simulateSavedPolicy(
  policyId: number,
  body: {
    sample_events?: Record<string, unknown>[]
    stream_ids?: number[]
  },
): Promise<GovernancePolicySimulateResponse | null> {
  return requestJson(`${GOV}/policies/${policyId}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
