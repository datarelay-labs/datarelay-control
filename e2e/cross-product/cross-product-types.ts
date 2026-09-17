/**
 * Full Cross-Product E2E types.
 * Axes reflect Runtime/Manifest-supported values only.
 * Independent of the existing 332-scenario matrix types (those remain unchanged).
 */

export type ExecutionSurface = 'API_SEEDED' | 'BROWSER'
/** ROUTE_OFF is retired (historical matrix only; generator emits ROUTE_ON). */
export type RouteRuntime = 'ROUTE_OFF' | 'ROUTE_ON'

export type SourceType =
  | 'HTTP_API_POLLING'
  | 'S3_OBJECT_POLLING'
  | 'DATABASE_QUERY'
  | 'REMOTE_FILE_POLLING'
  | 'WEBHOOK_RECEIVER'

export type SourceAuth =
  | 'no_auth'
  | 'basic'
  | 'bearer'
  | 'api_key_header'
  | 'api_key_query'
  | 'oauth2_client_credentials'
  | 'session_login'
  | 'jwt_refresh_token'
  | 'vendor_jwt_exchange'
  | 's3_keys'
  | 'db_password'
  | 'ssh'
  | 'inbound_no_auth'
  | 'inbound_shared_secret_header'
  | 'inbound_bearer_token'

export type SourceConfigurationProfile = 'DEFAULT' | 'INCREMENTAL_READY' | 'WEBHOOK_PUSH'

export type CollectionMode = 'POLLING' | 'PUSH'

export type PayloadFormat = 'JSON'

export type RecordPathEventRootProfile = 'ROOT_ARRAY' | 'NESTED_DATA_EVENTS'

export type UnionSchemaProfile = 'BASELINE_WITH_RARE'

export type IncrementalFetch = 'OFF' | 'ON'

export type CheckpointStrategy = 'NONE' | 'WATERMARK_OR_CURSOR'

export type DedupStrategy = 'OFF' | 'EVENT_ID_SKIP_DUPLICATE'

export type SchemaDriftProfile = 'BASELINE_THEN_DRIFT'

export type UnknownFieldType = 'NONE' | 'NORMAL' | 'SENSITIVE'

export type UnknownFieldPolicy =
  | 'NONE'
  | 'PASS_THROUGH'
  | 'DROP_FIELD'
  | 'QUARANTINE'
  | 'AUTO_PROTECT'

export type SensitiveDetectionProfile = 'OFF' | 'ON'

export type ClassificationProfile = 'NONE' | 'CONFIDENTIAL'

export type Activation = 'OFF' | 'ON'

export type GlobalProcessing = 'STREAM_DEFAULT'

export type RouteTopology =
  | 'SINGLE_ROUTE'
  | 'MULTI_ROUTE_ALL_INHERIT'
  | 'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE'
  | 'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE'
  | 'MULTI_ROUTE_MIXED_POLICY_OVERRIDE'
  | 'MULTI_ROUTE_MIXED_DESTINATION_TYPE'
  | 'MULTI_ROUTE_SAME_DESTINATION_TYPE_DIFFERENT_INSTANCE'
  | 'MULTI_ROUTE_MIXED_DELIVERY_OUTCOME'
  | 'FAILOVER_ROUTE'

export type RouteInheritance = 'ALL_INHERIT' | 'MIXED_OVERRIDE' | 'NOT_APPLICABLE'

export type ProtectionAction = 'audit' | 'mask_partial' | 'tokenize' | 'hash' | 'drop_field'

export type DeliveryBehavior = 'continue' | 'quarantine' | 'block'

export type DestinationType = 'SYSLOG_UDP' | 'SYSLOG_TCP' | 'SYSLOG_TLS' | 'WEBHOOK_POST'

export type DestinationAuthProtocol = 'NONE' | 'SYSLOG_TLS_MTLS' | 'WEBHOOK_HEADERS_UNSUPPORTED'

export type RuntimeCondition = 'NOMINAL' | 'FAULT_INJECTED'

export type FaultType =
  | 'NONE'
  | 'http_401'
  | 'http_403'
  | 'http_429'
  | 'http_500'
  | 'http_timeout'
  | 'malformed_response'
  | 'db_disconnect'
  | 's3_unavailable'
  | 'sftp_unavailable'
  | 'webhook_destination_down'
  | 'syslog_destination_down'
  | 'tls_certificate_error'
  | 'partial_route_failure'
  | 'api_restart'
  | 'runtime_restart'

export type ReplayMode = 'NONE' | 'REPLAY_AFTER_RECOVERY'

export type FailoverMode = 'NONE' | 'FAILOVER_ON_DESTINATION_FAILURE'

/** Normalized axis tuple — every free/dependent axis present. */
export type CrossProductAxes = {
  execution_surface: ExecutionSurface
  route_runtime: RouteRuntime
  source_type: SourceType
  source_auth: SourceAuth
  source_configuration_profile: SourceConfigurationProfile
  collection_mode: CollectionMode
  payload_format: PayloadFormat
  record_path_event_root_profile: RecordPathEventRootProfile
  union_schema_profile: UnionSchemaProfile
  incremental_fetch: IncrementalFetch
  checkpoint_strategy: CheckpointStrategy
  dedup_strategy: DedupStrategy
  schema_drift_profile: SchemaDriftProfile
  unknown_field_type: UnknownFieldType
  unknown_field_policy: UnknownFieldPolicy
  sensitive_detection_profile: SensitiveDetectionProfile
  classification_profile: ClassificationProfile
  field_mapping: Activation
  timestamp_normalization: Activation
  jsonata: Activation
  regex: Activation
  global_processing: GlobalProcessing
  route_topology: RouteTopology
  route_inheritance: RouteInheritance
  route_transform_override: Activation
  route_protection_override: Activation
  route_classification_override: Activation
  route_policy_override: Activation
  protection_action: ProtectionAction
  delivery_behavior: DeliveryBehavior
  destination_type: DestinationType
  destination_auth_protocol: DestinationAuthProtocol
  runtime_condition: RuntimeCondition
  fault_type: FaultType
  replay_mode: ReplayMode
  failover_mode: FailoverMode
}

export type ApplicabilityDecision = 'allowed' | 'rejected'

export type ApplicabilityRuleResult = {
  rule_id: string
  decision: ApplicabilityDecision
  reason: string
  capability_ids: string[]
  evidence: string
}

export type ValidCombination = {
  combination_id: string
  axes: CrossProductAxes
  capability_ids: string[]
  expected_status: 'PASS'
  browser_supported: boolean
  estimated_cost: number
}

export type NotApplicableCombination = {
  combination_id: string
  axes: CrossProductAxes
  rule_id: string
  reason: string
  capability_ids: string[]
  evidence: string
}

export type GenerationSummary = {
  generated_at: string
  manifest_hash: string
  applicability_rules_hash: string
  axes_hash: string
  /** Unique combination_id count from the candidate stream (deduped). */
  candidate_combinations: number
  /** Raw iterator emissions before unique-id dedupe (informational). */
  candidate_emissions: number
  /** Orthogonal-product duplicate emissions (already classified on first sighting). */
  duplicate_emissions: number
  valid_combinations: number
  not_applicable_combinations: number
  /**
   * Cross-product combinations classified NOT_IMPLEMENTED.
   * NI capabilities are axis-excluded (R021); frozen 20 scenario IDs are suite-level, not xp combinations.
   * Must satisfy: candidates = valid + not_applicable + not_implemented_combinations
   */
  not_implemented_combinations: number
  not_implemented_capability_ids: string[]
  not_implemented_scenario_ids: string[]
  browser_combinations: number
  api_combinations: number
  route_off_combinations: number
  route_on_combinations: number
  by_source: Record<string, number>
  by_destination: Record<string, number>
  by_fault: Record<string, number>
  by_rule_reject: Record<string, number>
  combination_id_set_hash: string
  classification_equation_ok: boolean
  deterministic: true
}

export type NotImplementedCombination = {
  combination_id: string
  axes: CrossProductAxes
  capability_ids: string[]
  reason: string
  evidence: string
}

export type ShardPlanEntry = {
  shard_id: string
  combination_ids: string[]
  estimated_cost: number
  browser_count: number
  api_count: number
  fault_count: number
  route_off_count: number
  route_on_count: number
  isolated_compose: boolean
}

export type CrossProductScenario = {
  id: string
  combination_id: string
  suite: 'cross_product'
  executionMode: 'browser' | 'api_seeded'
  routeProcessing: 'off' | 'on'
  axes: CrossProductAxes
  capabilities: string[]
  fixture: string
  expectedStatus: 'PASS'
  tags: string[]
  shard?: string
  estimatedCost: number
}

export type CrossProductRunResult = {
  combination_id: string
  scenarioId: string
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'GAP' | 'NOT_APPLICABLE' | 'NOT_IMPLEMENTED' | 'SUPERSEDED'
  classification?: string
  detail?: string
  durationMs: number
  route_results?: Array<{
    route_key: string
    delivery_outcome: string
    collector_count: number
    payload_match: boolean
  }>
  cleanup_ok?: boolean
  field_diff_count?: number
  runtime_collector_mismatch?: number
  shard?: string
  commit?: string
  git_commit?: string
  manifest_hash?: string
  applicability_rules_hash?: string
  axes_hash?: string
  executor_hash?: string
  driver_hash?: string
  spec_hash?: string
  oracle_hash?: string
  fixture_hash?: string
  harness_version?: string
  finishedAt?: string
  result_status?: 'SUPERSEDED' | 'ACTIVE'
}

export type CrossAxisGateResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  expected_valid: number
  executed: number
  missing_combination_ids: string[]
  duplicate_combination_ids: string[]
  results_without_combination: string[]
  unjustified_not_applicable: number
  browser_missing: number
  route_evidence_missing: number
  collector_evidence_missing: number
  cleanup_failures: number
  remaining_full_e2e_resources: number
  not_implemented_unchanged: boolean
  fail: number
  blocked: number
  gap: number
  missing: number
  harness_hash_mismatches: number
  superseded_included: number
  runtime_collector_mismatches: number
}
