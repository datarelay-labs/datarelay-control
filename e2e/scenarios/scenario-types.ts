/** Phase 3 Full Matrix E2E scenario model (generated from Capability Manifest). */

export type ScenarioSuite =
  | 'authentication'
  | 'source'
  | 'destination'
  | 'wizard'
  | 'processing'
  | 'route'
  | 'governance'
  | 'runtime'
  | 'fault'

export type ExecutionMode = 'browser' | 'api_seeded'

export type RouteProcessing = 'off' | 'on' | 'both'

export type ExpectedStatus =
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'
  | 'NOT_APPLICABLE'
  | 'NOT_IMPLEMENTED'
  | 'KNOWN_PRODUCT_GAP'

export type FailureClassification =
  | 'UI'
  | 'API'
  | 'PERSISTENCE'
  | 'RUNTIME'
  | 'SOURCE_FIXTURE'
  | 'DESTINATION_FIXTURE'
  | 'ROUTE'
  | 'GOVERNANCE'
  | 'TEST_INFRA'
  | 'KNOWN_PRODUCT_GAP'

export type E2EScenario = {
  id: string
  suite: ScenarioSuite
  executionMode: ExecutionMode
  routeProcessing: RouteProcessing
  source?: {
    type: string
    variant?: string
    authentication?: string
  }
  destination?: {
    type: string
    variant?: string
    authentication?: string
  }
  capabilities: string[]
  fixture: string
  expectedStatus: ExpectedStatus
  tags: string[]
  /** Why NOT_APPLICABLE / BLOCKED / NOT_IMPLEMENTED when pre-classified */
  reason?: string
  /** Auth outcome for authentication suite */
  authOutcome?: 'success' | 'failure'
  /** Processing / governance specifics */
  transform?: string
  protectionAction?: string
  deliveryBehavior?: string
  faultType?: string
  shard?: string
}

export type NotApplicableRecord = {
  combination: string
  reason: string
  capabilities?: string[]
}

export type CapabilityRecord = {
  id: string
  display_name?: string
  status: string
  ui_supported?: boolean | string
  api_supported?: boolean | string
  runtime_supported?: boolean | string
  connection_test_supported?: boolean | string
  applicable_to?: string[]
  feature_flag?: string | null
  product_scope?: string
  limitations?: string[]
  required_e2e?: string[]
}

export type Manifest = {
  metadata?: Record<string, unknown>
  authentication: CapabilityRecord[]
  sources: CapabilityRecord[]
  destinations: CapabilityRecord[]
  wizard: CapabilityRecord[]
  processing: CapabilityRecord[]
  routes: CapabilityRecord[]
  governance: CapabilityRecord[]
  runtime: CapabilityRecord[]
  feature_flags: CapabilityRecord[]
  test_infrastructure: CapabilityRecord[]
}

export type MatrixBundle = {
  generated_at: string
  manifest_commit?: string
  scenarios: E2EScenario[]
  not_applicable: NotApplicableRecord[]
  counts: {
    total: number
    browser: number
    api_seeded: number
    route_off: number
    route_on: number
    route_both: number
    by_suite: Record<string, number>
    by_expected_status: Record<string, number>
  }
}

export type CoverageValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  supported_without_scenario: string[]
  unknown_capability_refs: string[]
  duplicate_scenario_ids: string[]
  stats: {
    supported_capabilities: number
    scenarios: number
    not_applicable: number
  }
}
