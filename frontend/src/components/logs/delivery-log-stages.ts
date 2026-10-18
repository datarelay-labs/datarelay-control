/**
 * Canonical delivery_logs.stage tokens shared by Governance drill-down, Logs Explorer URL
 * filters, and client-side row matching. Keep in sync with backend writers (stream_runner
 * allowlist, quarantine/replay observability helpers).
 */

import type { LogExplorerRow } from './logs-types'
import { pipelineStageLabel } from './logs-types'

/** Pipeline lifecycle categories for manual Logs Explorer filtering (not URL tokens). */
export const PIPELINE_STAGE_FILTER_OPTIONS = [
  'All Stages',
  'POLLING',
  'SOURCE',
  'PARSING',
  'MAPPING',
  'DELIVERY',
  'RETRY',
  'CHECKPOINT',
] as const

export type PipelineStageFilterOption = (typeof PIPELINE_STAGE_FILTER_OPTIONS)[number]

/** Schema Drift Policy runtime observability stages (StreamRunner._persist_delivery_log). */
export const SCHEMA_DRIFT_POLICY_DELIVERY_LOG_STAGES = [
  'schema_drift_policy',
  'schema_drift_policy_review_required',
  'schema_drift_policy_path_resolution_failed',
  'schema_drift_policy_auto_protect_applied',
] as const

export type SchemaDriftPolicyDeliveryLogStage = (typeof SCHEMA_DRIFT_POLICY_DELIVERY_LOG_STAGES)[number]

export const SCHEMA_DRIFT_POLICY_LOG_DRILLDOWN_STAGES = {
  policy: 'schema_drift_policy',
  autoProtectApplied: 'schema_drift_policy_auto_protect_applied',
  reviewRequired: 'schema_drift_policy_review_required',
  pathResolutionFailed: 'schema_drift_policy_path_resolution_failed',
} as const

/** Governance card / risk overview drill-down stages (exact delivery_logs.stage values). */
export const GOVERNANCE_LOG_DRILLDOWN_STAGES = {
  classification: 'classification_complete',
  protection: 'protection_complete',
  policy: 'policy_evaluation_complete',
  policyComplete: 'policy_complete',
  policyBlocked: 'policy_blocked',
  policyQuarantine: 'policy_quarantine',
  policyReviewRequired: 'policy_review_required',
  quarantine: 'quarantine_event_created',
  replay: 'replay_event_replayed',
} as const

export type GovernanceOutcomeKind = 'workspace' | 'quarantine'

export type GovernanceOutcomePresentation = {
  kind: GovernanceOutcomeKind
  label: string
  summary: string
}

/**
 * Product-stage interpretation only. This never changes policy or delivery state.
 * Policy dispositions occur before destination delivery and must not be described
 * as receiver failures.
 */
export function governanceOutcomePresentation(
  stageToken: string | null | undefined,
): GovernanceOutcomePresentation | null {
  const stage = String(stageToken ?? '').trim().toLowerCase()
  if (stage === 'policy_blocked') {
    return {
      kind: 'workspace',
      label: 'Review blocked policy decision',
      summary: 'Policy blocked this Route before destination delivery. This is a governance disposition, not a receiver delivery failure.',
    }
  }
  if (stage === 'policy_review_required' || stage === 'schema_drift_policy_review_required') {
    return {
      kind: 'workspace',
      label: 'Review required in Governance',
      summary: 'Delivery is waiting on a governance review decision. No receiver delivery is claimed for this outcome.',
    }
  }
  if (stage === 'policy_quarantine' || stage.startsWith('quarantine_event_')) {
    return {
      kind: 'quarantine',
      label: 'Open Quarantine',
      summary: 'Events were routed to quarantine before destination delivery. Quarantine is a governance outcome, not a delivery failure.',
    }
  }
  if (
    stage === 'classification_complete' ||
    stage === 'protection_complete' ||
    stage === 'policy_evaluation_complete' ||
    stage === 'policy_complete' ||
    stage === 'schema_drift_policy' ||
    stage === 'schema_drift_policy_auto_protect_applied' ||
    stage === 'schema_drift_policy_path_resolution_failed'
  ) {
    return {
      kind: 'workspace',
      label: 'Open Governance context',
      summary: 'This row records governance-stage processing. Review the effective Stream and Route policy context in Governance.',
    }
  }
  return null
}

export type GovernanceLogDrilldownStage =
  (typeof GOVERNANCE_LOG_DRILLDOWN_STAGES)[keyof typeof GOVERNANCE_LOG_DRILLDOWN_STAGES]

/** Stages persisted via StreamRunner._persist_delivery_log allowlist. */
export const STREAM_RUNNER_DELIVERY_LOG_STAGES = [
  'run_started',
  'source_fetch',
  'parse',
  'mapping',
  'enrichment',
  'classification_complete',
  'protection_complete',
  'policy_evaluation_complete',
  'policy_complete',
  'policy_blocked',
  'policy_quarantine',
  'policy_review_required',
  'dynamic_routing_complete',
  'dynamic_route_send_success',
  'dynamic_route_send_failed',
  'dynamic_route_send_skip',
  'dynamic_route_send_rate_limited',
  'dynamic_route_skip',
  'dynamic_route_rate_limited',
  'failover_routing_complete',
  'failover_route_attempt',
  'failover_route_send_success',
  'failover_route_send_failed',
  'route',
  'route_send_success',
  'route_send_failed',
  'route_retry_success',
  'route_retry_failed',
  'source_rate_limited',
  'destination_rate_limited',
  'route_skip',
  'route_unknown_failure_policy',
  'checkpoint_update',
  'run_complete',
] as const

/** Quarantine / replay observability stages (direct DeliveryLog writes). */
export const QUARANTINE_REPLAY_DELIVERY_LOG_STAGES = [
  'quarantine_event_created',
  'quarantine_event_create_failed',
  'quarantine_event_released',
  'quarantine_event_release_failed',
  'quarantine_event_discarded',
  'replay_event_recorded',
  'replay_event_record_failed',
  'replay_event_replayed',
  'replay_event_replay_failed',
  'replay_event_discarded',
] as const

const ALL_KNOWN_BACKEND_STAGES = new Set<string>([
  ...STREAM_RUNNER_DELIVERY_LOG_STAGES,
  ...QUARANTINE_REPLAY_DELIVERY_LOG_STAGES,
  ...SCHEMA_DRIFT_POLICY_DELIVERY_LOG_STAGES,
])

const STAGE_DISPLAY_LABELS: Record<string, string> = {
  classification_complete: 'Classification complete',
  protection_complete: 'Protection complete',
  policy_evaluation_complete: 'Policy evaluation complete',
  policy_complete: 'Policy audit complete',
  policy_blocked: 'Policy blocked delivery',
  policy_quarantine: 'Policy quarantined events',
  policy_review_required: 'Policy review required',
  quarantine_event_created: 'Quarantine event created',
  replay_event_replayed: 'Replay event replayed',
  route_send_success: 'Route send success',
  route_send_failed: 'Route send failed',
  route_retry_success: 'Route retry success',
  route_retry_failed: 'Route retry failed',
  run_started: 'Run started',
  run_complete: 'Run complete',
  checkpoint_update: 'Checkpoint update',
  source_rate_limited: 'Source rate limited',
  destination_rate_limited: 'Destination rate limited',
  schema_drift_policy: 'Schema Drift Policy',
  schema_drift_policy_auto_protect_applied: 'Auto Protect Applied',
  schema_drift_policy_review_required: 'Schema Drift Review Required',
  schema_drift_policy_path_resolution_failed: 'Path Resolution Failed',
}

export function isBackendDeliveryLogStageToken(raw: string | null | undefined): raw is string {
  if (raw == null) return false
  const trimmed = raw.trim()
  if (!/^[a-z][a-z0-9_]*$/i.test(trimmed) || !trimmed.includes('_')) return false
  return ALL_KNOWN_BACKEND_STAGES.has(trimmed) || trimmed.endsWith('_complete') || trimmed.includes('_event_')
}

/** Human label for URL `?stage=` chips and dropdown when a backend token is active. */
export function deliveryLogStageDisplayLabel(stageToken: string): string {
  const key = stageToken.trim().toLowerCase()
  const mapped = STAGE_DISPLAY_LABELS[key]
  if (mapped) return mapped
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Resolve Logs Explorer stage filter value from URL (backend token or pipeline category). */
export function stageFilterValueFromUrl(raw: string | null | undefined): string {
  if (raw == null || raw.trim() === '') return PIPELINE_STAGE_FILTER_OPTIONS[0]
  const trimmed = raw.trim()
  if ((PIPELINE_STAGE_FILTER_OPTIONS as readonly string[]).includes(trimmed)) return trimmed
  if (isBackendDeliveryLogStageToken(trimmed)) return trimmed
  return PIPELINE_STAGE_FILTER_OPTIONS[0]
}

/** Dropdown options: pipeline categories plus active backend stage token when URL-driven. */
export function stageFilterDropdownOptions(activeStageFilter: string): readonly string[] {
  if (
    activeStageFilter !== PIPELINE_STAGE_FILTER_OPTIONS[0] &&
    isBackendDeliveryLogStageToken(activeStageFilter) &&
    !(PIPELINE_STAGE_FILTER_OPTIONS as readonly string[]).includes(activeStageFilter)
  ) {
    return [...PIPELINE_STAGE_FILTER_OPTIONS, activeStageFilter]
  }
  return PIPELINE_STAGE_FILTER_OPTIONS
}

export function stageFilterDropdownLabel(option: string): string {
  if ((PIPELINE_STAGE_FILTER_OPTIONS as readonly string[]).includes(option)) return option
  if (isBackendDeliveryLogStageToken(option)) return deliveryLogStageDisplayLabel(option)
  return option
}

/** Client-side row match: skip when API already filtered by exact backend stage. */
export function rowMatchesStageFilter(
  row: LogExplorerRow,
  stageFilter: string,
  apiStageFilter: string | undefined,
): boolean {
  if (stageFilter === PIPELINE_STAGE_FILTER_OPTIONS[0]) return true
  if (apiStageFilter && isBackendDeliveryLogStageToken(apiStageFilter)) {
    return true
  }
  const backendStage = String(row.contextJson.stage ?? '').toLowerCase()
  if (isBackendDeliveryLogStageToken(stageFilter) && backendStage === stageFilter.toLowerCase()) {
    return true
  }
  return pipelineStageLabel(row) === stageFilter
}
