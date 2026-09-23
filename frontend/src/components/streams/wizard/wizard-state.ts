/**
 * State model for the multi-step Stream Onboarding Wizard.
 *
 * Wizard flow (Stream Wizard UX Charter v5.2 — P1 structure MVP):
 *
 *   0. connect            — Connector · auth · request · test connection
 *   1. sample             — Sample response · record path · event root · checkpoint
 *   2. destinations       — Destination selection · route drafts
 *   3. route_processing   — Shared stream transform · data protection · route cards
 *   4. deploy             — Deployment decision center · create · start
 *
 * Legacy sub-steps (connector, stream, api_test, …) remain for internal completion
 * tracking, edit shortcuts, and draft migration — not shown in the stepper.
 */

import type { AdvancedTransformRuleDraft, MappingMode } from '../../../types/advancedTransform'
import { buildFieldMappingsWithTransformRules } from '../../../utils/advancedTransformConfig'
import type { UnionSchema } from '../../../utils/unionSchema'
import { buildWizardJsonataPreviewFieldMappings } from './wizard-full-event-preview'
import {
  buildFieldMappingsFromFullEventRegexConfigJson,
  hasValidFullEventRegexConfigJson,
} from './wizard-full-event-regex-config'
import type { ConnectorRead } from '../../../api/gdcConnectors'
import type { CatalogConnector, CatalogSource } from '../../../api/gdcCatalog'
import type { ConnectorAuthTestResponse } from '../../../api/gdcRuntimePreview'
import {
  DEFAULT_MESSAGE_PREFIX_TEMPLATE,
  defaultMessagePrefixEnabled,
} from '../../../utils/messagePrefixDefaults'
import {
  applyIncrementalRequestTemplate,
  type IncrementalRequestPattern,
} from './wizard-incremental-request'
import {
  buildAdvancedStreamConfigJsonPatch,
  mergeStreamConfigJson,
} from './wizard-stream-config-sync'

/** Top-level wizard steps (Stream Wizard UX Charter v5.2 — P1 structure MVP). */
export const WIZARD_STEP_KEYS = [
  'connect',
  'sample',
  'destinations',
  'route_processing',
  'deploy',
] as const

export type WizardStepKey = (typeof WIZARD_STEP_KEYS)[number]

/** Internal legacy sub-steps — hidden from the v3 stepper; used for completion + edit shortcuts. */
export const WIZARD_LEGACY_SUBSTEP_KEYS = [
  'connector',
  'stream',
  'api_test',
  'preview',
  'mapping',
  'enrichment',
  'data_protection',
  'destinations',
  'review',
  'done',
] as const

export type WizardLegacySubstepKey = (typeof WIZARD_LEGACY_SUBSTEP_KEYS)[number]

export type WizardStepDef = {
  key: WizardStepKey
  title: string
  subtitle: string
}

export const WIZARD_STEPS: ReadonlyArray<WizardStepDef> = [
  { key: 'connect', title: 'Connect', subtitle: 'Source · auth · request' },
  { key: 'sample', title: 'Sample & Record Selection', subtitle: 'Test · confirm records' },
  { key: 'destinations', title: 'Destinations', subtitle: 'Choose delivery targets' },
  { key: 'route_processing', title: 'Route Processing', subtitle: 'Per-destination processing' },
  { key: 'deploy', title: 'Deploy', subtitle: 'Readiness · create · start' },
]

/** Map a legacy sub-step key to its v3 wizard step (for edit shortcuts and draft migration). */
export function legacySubstepToWizardStep(key: WizardLegacySubstepKey): WizardStepKey {
  switch (key) {
    case 'connector':
    case 'stream':
    case 'api_test':
      return 'connect'
    case 'preview':
      return 'sample'
    case 'mapping':
    case 'enrichment':
    case 'data_protection':
      return 'route_processing'
    case 'destinations':
      return 'destinations'
    case 'review':
    case 'done':
      return 'deploy'
    default:
      return 'connect'
  }
}

/** Map a legacy 9-step stepper index to the v5.2 5-step index. */
export function migrateLegacyStepIndex(legacyIndex: number): number {
  if (legacyIndex <= 2) return 0
  if (legacyIndex === 3) return 1
  if (legacyIndex === 7) return 2
  if (legacyIndex <= 6) return 3
  return 4
}

export type WizardDataPolicyPreset = 'minimal' | 'standard' | 'strict'

export type WizardDataPolicyState = {
  preset: WizardDataPolicyPreset
  sensitiveAutoDetect: boolean
  dataShapeAlert: boolean
  maskPii: boolean
  defaultMaskMode: 'partial' | 'full' | 'tokenize'
  defaultClassification: string
  restrictedResponse: 'quarantine' | 'block' | 'audit'
  confidentialResponse: 'audit' | 'mask' | 'quarantine'
}

export const INITIAL_DATA_POLICY: WizardDataPolicyState = {
  preset: 'standard',
  sensitiveAutoDetect: true,
  dataShapeAlert: true,
  maskPii: true,
  defaultMaskMode: 'partial',
  defaultClassification: 'INTERNAL',
  restrictedResponse: 'quarantine',
  confidentialResponse: 'audit',
}

export function dataPolicyPresetPatch(preset: WizardDataPolicyPreset): Partial<WizardDataPolicyState> {
  if (preset === 'minimal') {
    return {
      preset,
      sensitiveAutoDetect: true,
      dataShapeAlert: false,
      maskPii: false,
      defaultMaskMode: 'partial',
      restrictedResponse: 'audit',
      confidentialResponse: 'audit',
    }
  }
  if (preset === 'strict') {
    return {
      preset,
      sensitiveAutoDetect: true,
      dataShapeAlert: true,
      maskPii: true,
      defaultMaskMode: 'full',
      restrictedResponse: 'quarantine',
      confidentialResponse: 'quarantine',
    }
  }
  return {
    preset: 'standard',
    sensitiveAutoDetect: true,
    dataShapeAlert: true,
    maskPii: true,
    defaultMaskMode: 'partial',
    restrictedResponse: 'quarantine',
    confidentialResponse: 'audit',
  }
}

/** Operator-facing protection action (wizard intent only — no engine names). */
export type WizardProtectionAction =
  | 'audit'
  | 'mask_partial'
  | 'mask_full'
  | 'tokenize'
  | 'hash'
  | 'drop_field'

/** Legacy draft `remove` preserves field-removal intent via supported `drop_field`. */
export function normalizeWizardProtectionAction(action: unknown): WizardProtectionAction {
  if (
    action === 'audit' ||
    action === 'mask_partial' ||
    action === 'mask_full' ||
    action === 'tokenize' ||
    action === 'hash' ||
    action === 'drop_field'
  ) {
    return action
  }
  if (action === 'remove') return 'drop_field'
  return 'audit'
}

/** Operator-facing delivery behavior when sensitive data is present. */
export type WizardDeliveryBehavior = 'continue' | 'quarantine' | 'block'

export type WizardSensitivityClass = 'pii' | 'secret' | 'security_metadata'

export type WizardDataProtectionIntent = {
  /** Stable React/client key (not sent to API). */
  key: string
  detectedField: string
  protectionAction: WizardProtectionAction
  deliveryBehavior: WizardDeliveryBehavior
}

/** Per-route protection override draft (wizard intent; persisted via Contract v1 PUT governance). */
export type WizardRouteProtectionOverride = {
  /** Stable React/client key (not sent to API). */
  key: string
  fieldPath: string
  /** Links to `WizardRouteDraft.key` until deploy maps to route_id. */
  routeDraftKey: string
  protectionAction: WizardProtectionAction
  deliveryBehavior: WizardDeliveryBehavior
  enabled: boolean
}

/** Per-route classification floor override (route-level; persisted via Contract v1 PUT governance). */
export type WizardClassificationLevel = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'

export type WizardRouteClassificationOverride = {
  /** Stable React/client key (not sent to API). */
  key: string
  /** Links to `WizardRouteDraft.key` until deploy maps to route_id. */
  routeDraftKey: string
  classificationLevel: WizardClassificationLevel
  enabled: boolean
}

/** How to handle newly appearing non-sensitive fields (wizard intent only). */
export type WizardUnknownNormalFieldPolicy =
  | 'pass_through'
  | 'require_review'
  | 'drop_field'
  | 'quarantine'

/** How to handle newly appearing sensitive fields (wizard intent only). */
export type WizardUnknownSensitiveFieldPolicy =
  | 'auto_protect'
  | 'require_review'
  | 'drop_field'
  | 'quarantine'

/** Unmapped source field handling for basic JSONPath mapping. */
export type WizardUnmappedFieldsPolicy = 'pass_through' | 'drop_unmapped'

export type WizardDataProtectionState = {
  intents: WizardDataProtectionIntent[]
  routeOverrides: WizardRouteProtectionOverride[]
  routeClassificationOverrides: WizardRouteClassificationOverride[]
  unknownNormalFieldPolicy: WizardUnknownNormalFieldPolicy
  unknownSensitiveFieldPolicy: WizardUnknownSensitiveFieldPolicy
}

export const INITIAL_DATA_PROTECTION: WizardDataProtectionState = {
  intents: [],
  routeOverrides: [],
  routeClassificationOverrides: [],
  unknownNormalFieldPolicy: 'pass_through',
  unknownSensitiveFieldPolicy: 'auto_protect',
}

export function normalizeUnknownNormalFieldPolicy(value: unknown): WizardUnknownNormalFieldPolicy {
  if (
    value === 'pass_through' ||
    value === 'require_review' ||
    value === 'drop_field' ||
    value === 'quarantine'
  ) {
    return value
  }
  return 'pass_through'
}

export function normalizeUnknownSensitiveFieldPolicy(value: unknown): WizardUnknownSensitiveFieldPolicy {
  if (
    value === 'auto_protect' ||
    value === 'require_review' ||
    value === 'drop_field' ||
    value === 'quarantine'
  ) {
    return value
  }
  return 'auto_protect'
}

export function normalizeUnmappedFieldsPolicy(value: unknown): WizardUnmappedFieldsPolicy {
  if (value === 'drop_unmapped') return 'drop_unmapped'
  return 'pass_through'
}

export function newWizardDataProtectionIntentKey(): string {
  return `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newWizardRouteProtectionOverrideKey(): string {
  return `ro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newWizardRouteClassificationOverrideKey(): string {
  return `rco-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const WIZARD_CLASSIFICATION_LEVELS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const

export function normalizeWizardClassificationLevel(value: unknown): WizardClassificationLevel {
  const raw = String(value ?? '').trim().toUpperCase()
  if ((WIZARD_CLASSIFICATION_LEVELS as readonly string[]).includes(raw)) {
    return raw as WizardClassificationLevel
  }
  return 'INTERNAL'
}

export function normalizeWizardRouteClassificationOverride(
  raw: Partial<WizardRouteClassificationOverride>,
): WizardRouteClassificationOverride {
  return {
    key: raw.key || newWizardRouteClassificationOverrideKey(),
    routeDraftKey: raw.routeDraftKey ?? '',
    classificationLevel: normalizeWizardClassificationLevel(raw.classificationLevel),
    enabled: raw.enabled !== false,
  }
}

export function normalizeWizardRouteProtectionOverride(
  raw: Partial<WizardRouteProtectionOverride>,
): WizardRouteProtectionOverride {
  return {
    key: raw.key || newWizardRouteProtectionOverrideKey(),
    fieldPath: raw.fieldPath ?? '',
    routeDraftKey: raw.routeDraftKey ?? '',
    protectionAction: normalizeWizardProtectionAction(raw.protectionAction),
    deliveryBehavior:
      raw.deliveryBehavior === 'quarantine' || raw.deliveryBehavior === 'block'
        ? raw.deliveryBehavior
        : 'continue',
    enabled: raw.enabled !== false,
  }
}

export function wizardDataProtectionIntentReady(intent: WizardDataProtectionIntent): boolean {
  const field = intent.detectedField.trim()
  return field.length > 0 && field.startsWith('$')
}

export function wizardDataProtectionStepComplete(state: WizardDataProtectionState): boolean {
  if (state.intents.length === 0) return true
  return state.intents.every(wizardDataProtectionIntentReady)
}

export type AuthType =
  | 'NO_AUTH'
  | 'BASIC'
  | 'BEARER'
  | 'API_KEY'
  | 'OAUTH2_CLIENT_CREDENTIALS'
  | 'SESSION_LOGIN'
  | 'JWT_REFRESH_TOKEN'
export type ApiKeyLocation = 'headers' | 'query_params'

export type WizardConnectorState = {
  connectorId: number | null
  sourceId: number | null
  templateId: string | null
  /** Connector Registry module id (schema-driven Connect path). */
  registryModuleId: string | null
  /** Values collected from SchemaFormRenderer (not persisted until materialization). */
  schemaFormValues: Record<string, string | boolean | number>
  /** Selected Connector Module stream template ids for materialization. */
  selectedTemplateIds: string[]
  apiBacked: boolean
  candidates: { connectors: CatalogConnector[]; sources: CatalogSource[] }
  connectorName: string
  description: string
  hostBaseUrl: string
  /** Mirrors backend Source.source_type for the selected connector. */
  sourceType: 'HTTP_API_POLLING' | 'S3_OBJECT_POLLING' | 'DATABASE_QUERY' | 'REMOTE_FILE_POLLING' | 'WEBHOOK_RECEIVER'
  authType: AuthType
  verifySsl: boolean
  httpProxy: string
  commonHeaders: StreamConfigHeaderRow[]
  basicUsername: string
  basicPassword: string
  bearerToken: string
  apiKeyName: string
  apiKeyValue: string
  apiKeyLocation: ApiKeyLocation
  oauthClientId: string
  oauthClientSecret: string
  oauthTokenUrl: string
  oauthScope: string
  loginUrl: string
  loginPath: string
  loginMethod: 'POST' | 'PUT' | 'PATCH'
  loginUsername: string
  loginPassword: string
  loginHeaders: Record<string, string>
  loginBodyTemplate: Record<string, unknown>
  refreshToken: string
  tokenUrl: string
  tokenPath: string
  tokenHttpMethod: 'POST' | 'PUT' | 'PATCH'
  refreshTokenHeaderName: string
  refreshTokenHeaderPrefix: string
  accessTokenJsonPath: string
  accessTokenHeaderName: string
  accessTokenHeaderPrefix: string
  tokenTtlSeconds: number
}

export type StreamConfigHeaderRow = { id: string; key: string; value: string }
export type StreamConfigParamRow = { id: string; key: string; value: string }

export type WizardCheckpointFieldType = '' | 'TIMESTAMP' | 'EVENT_ID' | 'CURSOR' | 'OFFSET'
export type WizardRecordSelectionMode = 'basic' | 'advanced'

export type WizardHttpApiAnalysis = {
  responseSummary: {
    root_type: string
    approx_size_bytes: number
    top_level_keys: string[]
    item_count_root: number | null
    truncation: string | null
  }
  detectedArrays: Array<{
    path: string
    count: number
    confidence: number
    reason: string
    sample_item_preview?: unknown
  }>
  detectedCheckpointCandidates: Array<{
    path: string
    checkpoint_type: WizardCheckpointFieldType
    confidence: number
    sample_value: unknown
    reason: string
  }>
  sampleEvent: Record<string, unknown> | null
  selectedEventArrayDefault: string | null
  flatPreviewFields: string[]
  eventRootCandidates?: string[]
  /** Backend `preview_error` when body is not parseable JSON, oversized, or non-JSON. */
  previewError: string | null
}

export type WizardConfigState = {
  name: string
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  endpoint: string
  headers: StreamConfigHeaderRow[]
  params: StreamConfigParamRow[]
  requestBody: string
  pollingIntervalSec: number
  timeoutSec: number
  eventArrayPath: string
  eventRootPath: string
  /** True when user chose “entire response as single event” (empty event_array_path semantics). */
  useWholeResponseAsEvent: boolean
  /** JSONPath into a single event for checkpoint templates (e.g. $.creationTime). */
  checkpointFieldType: WizardCheckpointFieldType
  checkpointSourcePath: string
  /** Persisted checkpoint mode label (Cursor, Timestamp, Event ID, …). */
  checkpointMode: string
  /** Optional tie-breaker checkpoint path relative to each record. */
  checkpointSecondaryPath: string
  /** Optional schema root path stored on stream config_json.schema.root_path. */
  schemaRootPath: string
  initialDelaySec: number
  paginationType: string
  paginationCursorParam: string
  paginationPageSize: number
  paginationMaxPages: number
  rateLimitPerMinute: number
  rateLimitBurst: number
  /** S3_OBJECT_POLLING stream: objects fetched per StreamRunner execution (default 20). */
  maxObjectsPerRun: number
  /** REMOTE_FILE_POLLING: remote directory (required for sample fetch). */
  remoteDirectory: string
  filePattern: string
  remoteRecursive: boolean
  parserType: string
  maxFilesPerRun: number
  maxFileSizeMb: number
  encoding: string
  csvDelimiter: string
  lineEventField: string
  includeFileMetadata: boolean
  /** DATABASE_QUERY: SELECT-only SQL text persisted as config_json.query. */
  sqlQuery: string
  /** DATABASE_QUERY checkpoint column (optional; NONE mode when empty). */
  dbCheckpointColumn: string
  dbCheckpointMode: string
  /**
   * Incremental request template selected on the JSON Preview step.
   * This is used for incremental-request test previews only and must never
   * overwrite the operator's saved Connect-step request body.
   */
  incrementalRequestPattern: IncrementalRequestPattern
  /** Editable preview text for the selected incremental pattern (JSON body or `key=value` lines). */
  incrementalRequestDraft: string
  /** Last successful incremental request test signature (body + checkpoint + event source). */
  incrementalRequestTestSignature: string | null
  /** Epoch ms when incremental request test last succeeded. */
  incrementalRequestTestedAt: number | null
  /** Inline incremental request test outcome from JSON Preview (not persisted on stream). */
  incrementalRequestTestResult: WizardIncrementalRequestTestResult | null
  /** apiTest.finishedAt when the operator last confirmed record path for the current sample. */
  recordPathConfirmedForApiTestAt: number | null
  /** apiTest.finishedAt when the operator last confirmed event root for the current sample. */
  eventRootConfirmedForApiTestAt: number | null
  /** apiTest.finishedAt when the operator last confirmed sync position for the current sample. */
  checkpointConfirmedForApiTestAt: number | null
  /** Record Selection UX mode: tree-first basic mode or custom JSONPath mode. */
  recordSelectionMode: WizardRecordSelectionMode
  /** apiTest.finishedAt when custom extraction paths were last validated successfully. */
  customExtractionValidatedForApiTestAt: number | null
  /** Latest custom extraction validation status for the current sample. */
  customExtractionValidationOk: boolean
}

export type WizardIncrementalRequestTestResult = {
  status: 'success' | 'error'
  httpStatus: number | null
  durationMs: number | null
  returnedRecordCount: number
  testedCheckpointDisplay: string
  substitutedRequestBody: string
  sampleRecords: Array<Record<string, unknown>>
  rawResponseBody: string | null
  message: string
  testedAt: number
  signature: string
}

export type WizardApiTestStatus = 'idle' | 'running' | 'success' | 'error'

export type WizardApiTestStep = {
  name: string
  success: boolean
  status_code?: number | null
  message?: string
}

export type WizardApiTestState = {
  status: WizardApiTestStatus
  ok: boolean
  requestUrl: string | null
  method: string | null
  statusCode: number | null
  responseHeaders: Record<string, string>
  rawBody: string | null
  parsedJson: unknown
  rawResponse: unknown
  extractedEvents: Array<Record<string, unknown>>
  eventCount: number
  /** Union schema across all extracted events (Record Selection → Transform). */
  unionSchema: UnionSchema | null
  startedAt: number | null
  finishedAt: number | null
  errorCode: string | null
  errorType: string | null
  errorMessage: string | null
  targetStatusCode: number | null
  targetResponseBody: string | null
  hint: string | null
  /** Whether this preview came from real API (true) or local mock (false). */
  apiBacked: boolean
  /** Auth / HTTP steps from Stream API Test (masked headers; no plaintext secrets). */
  steps: WizardApiTestStep[]
  responseSample: unknown
  effectiveHeadersMasked: Record<string, string> | null
  actualRequestSent: {
    method: string
    url: string
    endpoint: string | null
    queryParams: Record<string, unknown>
    headersMasked: Record<string, string>
    jsonBodyMasked: unknown | null
    timeoutSeconds: number
  } | null
  /** Structured response analysis from backend (persists across wizard navigation). */
  analysis: WizardHttpApiAnalysis | null
  /** S3_OBJECT_POLLING: connectivity probe succeeded via connector-auth (replaces HTTP sample fetch). */
  s3ConnectivityPassed: boolean
  /** REMOTE_FILE_POLLING: last connector-auth probe (SSH/SFTP listing) before sample fetch. */
  remoteProbe?: ConnectorAuthTestResponse | null
  /** Fingerprint of connector/stream config this result was produced for; used to drop stale success. */
  configFingerprint?: string | null
}

/**
 * Origin of a mapping row. Defaults to undefined (= manual). Rows produced by
 * the "Stellar Cyber Metadata Mapping" suggestion menu are tagged with
 * `'stellar'` so the UI can render an inline `STELLAR` badge to differentiate
 * auto-applied suggestions from operator-authored mappings. Persisted as part
 * of the wizard draft only; backend payload does not need this field (the
 * runtime save path uses `output_field` / `source_json_path` exclusively).
 */
export type WizardMappingRowOrigin = 'manual' | 'stellar' | 'auto'

export type WizardMappingRow = {
  id: string
  outputField: string
  sourceJsonPath: string
  origin?: WizardMappingRowOrigin
}

import type { WizardEnrichmentRule } from './enrichment-rules-model'
export type { WizardEnrichmentRule as WizardEnrichmentRow } from './enrichment-rules-model'
import {
  enrichmentDictFromRules as enrichmentDictFromRows,
  normalizeWizardEnrichmentRules,
} from './enrichment-rules-model'
export { enrichmentDictFromRows, normalizeWizardEnrichmentRules }

/** Per-concern inherit flags — default all true (Route Processing UX v2). */
export type WizardRouteProcessingInherit = {
  transform: boolean
  protection: boolean
  classification: boolean
  policy: boolean
}

export const DEFAULT_ROUTE_PROCESSING_INHERIT: WizardRouteProcessingInherit = {
  transform: true,
  protection: true,
  classification: true,
  policy: true,
}

/** Route-level transform override draft (wizard intent only). */
export type WizardRouteTransformOverride = {
  mapping: WizardMappingRow[]
  mappingMode: MappingMode
  fullEventJsonataExpression: string
  fullEventRegexConfigJson: string
  transformRules: AdvancedTransformRuleDraft[]
  enrichment: WizardEnrichmentRule[]
  unmappedFieldsPolicy: WizardUnmappedFieldsPolicy
}

/** Route-level protection override draft (wizard intent only). */
export type WizardRouteProtectionOverrideState = Pick<
  WizardDataProtectionState,
  'intents' | 'unknownNormalFieldPolicy' | 'unknownSensitiveFieldPolicy'
>

/** Route-level policy override draft (wizard intent only). */
export type WizardRoutePolicyOverride = {
  deliveryBehavior: WizardDeliveryBehavior
}

export type WizardRouteProcessingOverrides = {
  transform?: WizardRouteTransformOverride
  protection?: WizardRouteProtectionOverrideState
  policy?: WizardRoutePolicyOverride
}

export type RouteProcessingStatus = 'Inherited' | 'Overridden' | 'Mixed'

/** Per-route draft for wizard Destinations step (persists to POST /routes/ on create). */
export type WizardRouteDraft = {
  /** Stable React/client key (not sent to API). */
  key: string
  destinationId: number
  enabled: boolean
  failurePolicy:
    | 'LOG_AND_CONTINUE'
    | 'PAUSE_STREAM_ON_FAILURE'
    | 'RETRY_AND_BACKOFF'
    | 'DISABLE_ROUTE_ON_FAILURE'
  /** Route-level rate limits (optional); merged with destination at runtime when empty. */
  rateLimitJson: Record<string, unknown>
  /** Inherit global processing per concern (default all true). */
  inherit: WizardRouteProcessingInherit
  /** Route-specific processing when inherit is unchecked for a concern. */
  overrides?: WizardRouteProcessingOverrides
}

export type WizardDestinationsState = {
  /** Ordered route plans — one POST /routes/ row per entry after stream creation. */
  routeDrafts: WizardRouteDraft[]
  /** destination_type per id — used for message-prefix defaults when creating routes */
  destinationKindsById: Record<number, string>
  /** Applied to every route created from this wizard step */
  messagePrefixTemplate: string
  /** Explicit per-destination override; omit key → use default by destination type at save */
  messagePrefixEnabledByDestinationId: Record<number, boolean | undefined>
  destinationApiBacked: boolean
}

export type WizardCreateOutcome = {
  streamId: number | null
  routeId: number | null
  /** All route ids returned from POST /routes/ during this creation (last id duplicated in routeId for backward compat). */
  routeIds: number[]
  mappingSaved: boolean
  enrichmentSaved: boolean
  dataProtectionSaved: boolean
  /** True when Contract v1 governance (rules + route_overrides) was persisted. */
  governanceSaved: boolean
  /** True when schema drift policy was persisted to streams.config_json.governance. */
  schemaDriftPolicySaved: boolean
  /** Phase 1 caveats for schema drift policy (e.g. Auto Protect not masking yet). */
  schemaDriftPolicyWarnings: string[]
  /** True when field-level masking could not be enforced until runtime findings exist. */
  dataProtectionEnforcementIncomplete: boolean
  dataProtectionWarnings: string[]
  errors: string[]
  apiBacked: boolean
  /** ISO timestamp from POST /streams/ response when available. */
  createdAt: string | null
  /** Stream ids created via template materialization (M17.5.4). */
  materializedStreamIds?: number[]
}

export type WizardState = {
  connector: WizardConnectorState
  stream: WizardConfigState
  apiTest: WizardApiTestState
  mapping: WizardMappingRow[]
  /** Mapping mode: Basic JSONPath vs Full Event JSONata / Regex (wizard UI draft). */
  mappingMode: MappingMode
  /** Full-event JSONata expression (Advanced tab). */
  fullEventJsonataExpression: string
  /** Full Event Regex Transform JSON config (Expert tab). */
  fullEventRegexConfigJson: string
  /** Per-field Advanced / Expert transform rules (persisted via field_mappings.transform_rules). */
  transformRules: AdvancedTransformRuleDraft[]
  /** Unmapped source fields: pass through (default) or drop at mapping. */
  unmappedFieldsPolicy: WizardUnmappedFieldsPolicy
  enrichment: WizardEnrichmentRule[]
  destinations: WizardDestinationsState
  /** Wizard-only data policy draft (legacy governance modal; superseded by dataProtection in v3). */
  dataPolicy: WizardDataPolicyState
  /** Data Protection step — operator intent persisted at deploy via governance APIs. */
  dataProtection: WizardDataProtectionState
  outcome: WizardCreateOutcome | null
  startMessage: string | null
}

export const INITIAL_CONFIG: WizardConfigState = {
  name: 'Generic HTTP Events',
  httpMethod: 'GET',
  endpoint: '/v1/events',
  headers: [],
  params: [],
  requestBody: '',
  pollingIntervalSec: 60,
  timeoutSec: 30,
  eventArrayPath: '',
  eventRootPath: '',
  useWholeResponseAsEvent: false,
  checkpointFieldType: '',
  checkpointSourcePath: '',
  checkpointMode: 'Cursor',
  checkpointSecondaryPath: '',
  schemaRootPath: '',
  initialDelaySec: 0,
  paginationType: 'None',
  paginationCursorParam: '',
  paginationPageSize: 0,
  paginationMaxPages: 0,
  rateLimitPerMinute: 60,
  rateLimitBurst: 10,
  maxObjectsPerRun: 20,
  remoteDirectory: '',
  filePattern: '*',
  remoteRecursive: false,
  parserType: 'NDJSON',
  maxFilesPerRun: 10,
  maxFileSizeMb: 5,
  encoding: 'utf-8',
  csvDelimiter: ',',
  lineEventField: 'line',
  includeFileMetadata: false,
  sqlQuery: '',
  dbCheckpointColumn: '',
  dbCheckpointMode: 'NONE',
  incrementalRequestPattern: 'json_body',
  incrementalRequestDraft: '',
  incrementalRequestTestSignature: null,
  incrementalRequestTestedAt: null,
  incrementalRequestTestResult: null,
  recordPathConfirmedForApiTestAt: null,
  eventRootConfirmedForApiTestAt: null,
  checkpointConfirmedForApiTestAt: null,
  recordSelectionMode: 'basic',
  customExtractionValidatedForApiTestAt: null,
  customExtractionValidationOk: false,
}

export const INITIAL_API_TEST: WizardApiTestState = {
  status: 'idle',
  ok: false,
  requestUrl: null,
  method: null,
  statusCode: null,
  responseHeaders: {},
  rawBody: null,
  parsedJson: null,
  rawResponse: null,
  extractedEvents: [],
  eventCount: 0,
  unionSchema: null,
  startedAt: null,
  finishedAt: null,
  errorCode: null,
  errorType: null,
  errorMessage: null,
  targetStatusCode: null,
  targetResponseBody: null,
  hint: null,
  apiBacked: false,
  steps: [],
  responseSample: null,
  effectiveHeadersMasked: null,
  actualRequestSent: null,
  analysis: null,
  s3ConnectivityPassed: false,
  remoteProbe: null,
  configFingerprint: null,
}

export const INITIAL_DESTINATIONS: WizardDestinationsState = {
  routeDrafts: [],
  destinationKindsById: {},
  messagePrefixTemplate: DEFAULT_MESSAGE_PREFIX_TEMPLATE,
  messagePrefixEnabledByDestinationId: {},
  destinationApiBacked: false,
}

export function newWizardRouteDraftKey(): string {
  return `wr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function normalizeWizardRouteProcessingInherit(
  raw: Partial<WizardRouteProcessingInherit> | undefined,
): WizardRouteProcessingInherit {
  return {
    transform: raw?.transform !== false,
    protection: raw?.protection !== false,
    classification: raw?.classification !== false,
    policy: raw?.policy !== false,
  }
}

export function buildRouteTransformOverrideFromGlobal(
  state: Pick<
    WizardState,
    | 'mapping'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'transformRules'
    | 'enrichment'
    | 'unmappedFieldsPolicy'
  >,
): WizardRouteTransformOverride {
  return {
    mapping: state.mapping.map((row) => ({ ...row })),
    mappingMode: state.mappingMode,
    fullEventJsonataExpression: state.fullEventJsonataExpression,
    fullEventRegexConfigJson: state.fullEventRegexConfigJson,
    transformRules: state.transformRules.map((rule) => ({ ...rule })),
    enrichment: state.enrichment.map((rule) => ({ ...rule })),
    unmappedFieldsPolicy: state.unmappedFieldsPolicy,
  }
}

export function buildRouteProtectionOverrideFromGlobal(
  dataProtection: WizardDataProtectionState,
): WizardRouteProtectionOverrideState {
  return {
    intents: dataProtection.intents.map((intent) => ({ ...intent })),
    unknownNormalFieldPolicy: dataProtection.unknownNormalFieldPolicy,
    unknownSensitiveFieldPolicy: dataProtection.unknownSensitiveFieldPolicy,
  }
}

export function normalizeWizardRouteDraft(
  raw: Partial<WizardRouteDraft>,
  globalState?: Pick<WizardState, 'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson' | 'transformRules' | 'enrichment' | 'unmappedFieldsPolicy' | 'dataProtection'>,
): WizardRouteDraft {
  const inherit = normalizeWizardRouteProcessingInherit(raw.inherit)
  const draft: WizardRouteDraft = {
    key: raw.key || newWizardRouteDraftKey(),
    destinationId: raw.destinationId ?? 0,
    enabled: raw.enabled !== false,
    failurePolicy: raw.failurePolicy ?? 'LOG_AND_CONTINUE',
    rateLimitJson:
      typeof raw.rateLimitJson === 'object' && raw.rateLimitJson && !Array.isArray(raw.rateLimitJson)
        ? { ...raw.rateLimitJson }
        : {},
    inherit,
    overrides: raw.overrides,
  }
  if (!inherit.transform && !draft.overrides?.transform && globalState) {
    draft.overrides = {
      ...draft.overrides,
      transform: buildRouteTransformOverrideFromGlobal(globalState),
    }
  }
  if (!inherit.protection && !draft.overrides?.protection && globalState) {
    draft.overrides = {
      ...draft.overrides,
      protection: buildRouteProtectionOverrideFromGlobal(globalState.dataProtection),
    }
  }
  return draft
}

export type WizardRouteProcessingStatuses = {
  transform: RouteProcessingStatus
  protection: RouteProcessingStatus
  classification: RouteProcessingStatus
  policy: RouteProcessingStatus
}

function routeHasProtectionFieldOverrides(
  dataProtection: Pick<WizardDataProtectionState, 'routeOverrides'>,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeOverrides.some((o) => o.enabled && o.routeDraftKey === routeDraftKey)
}

function routeHasClassificationOverride(
  dataProtection: Pick<WizardDataProtectionState, 'routeClassificationOverrides'>,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeClassificationOverrides.some(
    (o) => o.enabled && o.routeDraftKey === routeDraftKey,
  )
}

export function computeWizardRouteProcessingStatuses(
  draft: WizardRouteDraft,
  dataProtection: WizardDataProtectionState,
): WizardRouteProcessingStatuses {
  const inherit = normalizeWizardRouteProcessingInherit(draft.inherit)
  const protectionFieldOverrides = routeHasProtectionFieldOverrides(dataProtection, draft.key)
  const classificationOverride = routeHasClassificationOverride(dataProtection, draft.key)

  let transform: RouteProcessingStatus
  if (inherit.transform) {
    transform = 'Inherited'
  } else {
    const payload = routeTransformOverridePersistPayload(draft.overrides?.transform)
    if (!payload) {
      transform = 'Overridden'
    } else {
      const hasMapping = Object.keys(payload.fieldMappings).length > 0
      const hasEnrichment = Object.keys(payload.enrichment).length > 0
      transform = hasMapping && hasEnrichment ? 'Overridden' : 'Mixed'
    }
  }

  let protection: RouteProcessingStatus
  if (!inherit.protection) {
    protection = protectionFieldOverrides ? 'Mixed' : 'Overridden'
  } else if (protectionFieldOverrides) {
    protection = 'Overridden'
  } else {
    protection = 'Inherited'
  }

  let classification: RouteProcessingStatus
  if (!inherit.classification) {
    classification = classificationOverride ? 'Mixed' : 'Overridden'
  } else if (classificationOverride) {
    classification = 'Overridden'
  } else {
    classification = 'Inherited'
  }

  const policy: RouteProcessingStatus = inherit.policy ? 'Inherited' : 'Overridden'

  return { transform, protection, classification, policy }
}

export function globalTransformConfigured(
  state: Pick<WizardState, 'mapping' | 'transformRules' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson'>,
): boolean {
  if (wizardMappingContentReady(state as WizardState)) return true
  return state.transformRules.some((rule) => rule.outputField.trim().length > 0)
}

export function globalProtectionConfigured(dataProtection: WizardDataProtectionState): boolean {
  return (
    dataProtection.intents.some(wizardDataProtectionIntentReady) ||
    dataProtection.unknownNormalFieldPolicy !== 'pass_through' ||
    dataProtection.unknownSensitiveFieldPolicy !== 'auto_protect'
  )
}

/** Normalize persisted wizard JSON / legacy shapes into `routeDrafts`. */
export function normalizeWizardDestinations(destinations: Partial<WizardDestinationsState> | undefined): WizardDestinationsState {
  if (!destinations) return INITIAL_DESTINATIONS
  const merged: WizardDestinationsState = {
    ...INITIAL_DESTINATIONS,
    ...destinations,
    destinationKindsById: {
      ...INITIAL_DESTINATIONS.destinationKindsById,
      ...destinations.destinationKindsById,
    },
    messagePrefixEnabledByDestinationId: {
      ...INITIAL_DESTINATIONS.messagePrefixEnabledByDestinationId,
      ...destinations.messagePrefixEnabledByDestinationId,
    },
    routeDrafts: Array.isArray(destinations.routeDrafts) ? destinations.routeDrafts : INITIAL_DESTINATIONS.routeDrafts,
  }
  const drafts = merged.routeDrafts
  if (Array.isArray(drafts) && drafts.length > 0) {
    merged.routeDrafts = drafts.map((d) => normalizeWizardRouteDraft(d))
    return merged
  }
  const legacyIds = (destinations as { selectedDestinationIds?: number[] } | undefined)?.selectedDestinationIds
  const legacyPolicy = (destinations as { failurePolicy?: WizardRouteDraft['failurePolicy'] } | undefined)?.failurePolicy
  const legacyEnabled = (destinations as { routeEnabled?: boolean } | undefined)?.routeEnabled
  if (Array.isArray(legacyIds) && legacyIds.length > 0) {
    merged.routeDrafts = legacyIds.map((destinationId, idx) =>
      normalizeWizardRouteDraft({
        key: `legacy-${destinationId}-${idx}`,
        destinationId,
        enabled: legacyEnabled !== false,
        failurePolicy: legacyPolicy ?? 'LOG_AND_CONTINUE',
        rateLimitJson: {},
      }),
    )
  }
  return merged
}

export function buildInitialState(): WizardState {
  return {
    connector: {
      connectorId: null,
      sourceId: null,
      templateId: null,
      registryModuleId: null,
      schemaFormValues: {},
      selectedTemplateIds: [],
      apiBacked: false,
      candidates: { connectors: [], sources: [] },
      connectorName: '',
      description: '',
      hostBaseUrl: '',
      authType: 'NO_AUTH',
      verifySsl: true,
      httpProxy: '',
      commonHeaders: [],
      basicUsername: '',
      basicPassword: '',
      bearerToken: '',
      apiKeyName: '',
      apiKeyValue: '',
      apiKeyLocation: 'headers',
      oauthClientId: '',
      oauthClientSecret: '',
      oauthTokenUrl: '',
      oauthScope: '',
      loginUrl: '',
      loginPath: '',
      loginMethod: 'POST',
      loginUsername: '',
      loginPassword: '',
      loginHeaders: {},
      loginBodyTemplate: {},
      refreshToken: '',
      tokenUrl: '',
      tokenPath: '',
      tokenHttpMethod: 'POST',
      refreshTokenHeaderName: 'Authorization',
      refreshTokenHeaderPrefix: 'Bearer',
      accessTokenJsonPath: '$.access_token',
      accessTokenHeaderName: 'Authorization',
      accessTokenHeaderPrefix: 'Bearer',
      tokenTtlSeconds: 600,
      sourceType: 'HTTP_API_POLLING',
    },
    stream: {
      ...INITIAL_CONFIG,
      headers: [],
      params: [...INITIAL_CONFIG.params],
    },
    apiTest: { ...INITIAL_API_TEST },
    mapping: [],
    mappingMode: 'basic_jsonpath',
    fullEventJsonataExpression: '',
    fullEventRegexConfigJson: '',
    transformRules: [],
    unmappedFieldsPolicy: 'pass_through',
    enrichment: [],
    destinations: normalizeWizardDestinations(INITIAL_DESTINATIONS),
    dataPolicy: { ...INITIAL_DATA_POLICY },
    dataProtection: { ...INITIAL_DATA_PROTECTION },
    outcome: null,
    startMessage: null,
  }
}

export type StepCompletion = 'incomplete' | 'in_progress' | 'complete'

/** Pure status calculator — does not perform network calls. */
export function buildFullRequestUrl(hostBaseUrl: string, endpointPath: string): string {
  const base = hostBaseUrl.trim().replace(/\/$/, '')
  const ep = endpointPath.trim()
  if (!base || !ep) return ''
  return `${base}${ep.startsWith('/') ? ep : `/${ep}`}`
}

/** Merge connector common headers with stream headers (stream wins on key clash). */
export function effectiveRequestHeaders(
  connector: WizardConnectorState,
  stream: WizardConfigState,
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const row of connector.commonHeaders) {
    const k = row.key.trim()
    if (k) inherited[k] = row.value
  }
  const extra: Record<string, string> = {}
  for (const row of stream.headers) {
    const k = row.key.trim()
    if (k) extra[k] = row.value
  }
  return { ...inherited, ...extra }
}

export function mapConnectorApiAuthType(raw: string): AuthType {
  const x = raw.toLowerCase().replace(/-/g, '_')
  const table: Record<string, AuthType> = {
    no_auth: 'NO_AUTH',
    basic: 'BASIC',
    bearer: 'BEARER',
    api_key: 'API_KEY',
    oauth2_client_credentials: 'OAUTH2_CLIENT_CREDENTIALS',
    session_login: 'SESSION_LOGIN',
    jwt_refresh_token: 'JWT_REFRESH_TOKEN',
  }
  return table[x] ?? 'NO_AUTH'
}

/** Hydrate wizard connector slice from GET /connectors/:id (masked secrets OK — API Test uses connector_id server-side). */
/** Reset fields mirrored from API when user clears connector selection. */
export function resetInheritedConnectorFields(): Partial<WizardConnectorState> {
  return {
    registryModuleId: null,
    schemaFormValues: {},
    selectedTemplateIds: [],
    connectorName: '',
    description: '',
    hostBaseUrl: '',
    authType: 'NO_AUTH',
    verifySsl: true,
    httpProxy: '',
    commonHeaders: [],
    basicUsername: '',
    basicPassword: '',
    bearerToken: '',
    apiKeyName: '',
    apiKeyValue: '',
    apiKeyLocation: 'headers',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthTokenUrl: '',
    oauthScope: '',
    loginUrl: '',
    loginPath: '',
    loginMethod: 'POST',
    loginUsername: '',
    loginPassword: '',
    loginHeaders: {},
    loginBodyTemplate: {},
    refreshToken: '',
    tokenUrl: '',
    tokenPath: '',
    tokenHttpMethod: 'POST',
    refreshTokenHeaderName: 'Authorization',
    refreshTokenHeaderPrefix: 'Bearer',
    accessTokenJsonPath: '$.access_token',
    accessTokenHeaderName: 'Authorization',
    accessTokenHeaderPrefix: 'Bearer',
    tokenTtlSeconds: 600,
    sourceType: 'HTTP_API_POLLING',
  }
}

export function wizardConnectorPatchFromApi(row: ConnectorRead): Partial<WizardConnectorState> {
  const auth = (row.auth ?? {}) as Record<string, unknown>
  const authType = mapConnectorApiAuthType(String(auth.auth_type ?? row.auth_type ?? 'no_auth'))
  const commonHeaders = Object.entries(row.common_headers ?? {}).map(([key, value], idx) => ({
    id: `ch-${row.id}-${idx}`,
    key,
    value: String(value ?? ''),
  }))
  const lhRaw = auth.login_headers
  const loginHeaders =
    lhRaw && typeof lhRaw === 'object' && !Array.isArray(lhRaw)
      ? Object.fromEntries(
          Object.entries(lhRaw as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
        )
      : {}
  const lbRaw = auth.login_body_template
  const loginBodyTemplate =
    lbRaw && typeof lbRaw === 'object' && !Array.isArray(lbRaw)
      ? { ...(lbRaw as Record<string, unknown>) }
      : {}

  const stRaw = String(row.source_type ?? 'HTTP_API_POLLING').toUpperCase()
  const st: WizardConnectorState['sourceType'] =
    stRaw === 'S3_OBJECT_POLLING'
      ? 'S3_OBJECT_POLLING'
      : stRaw === 'REMOTE_FILE_POLLING'
        ? 'REMOTE_FILE_POLLING'
        : stRaw === 'WEBHOOK_RECEIVER'
          ? 'WEBHOOK_RECEIVER'
          : stRaw === 'DATABASE_QUERY'
            ? 'DATABASE_QUERY'
            : 'HTTP_API_POLLING'
  const baseUrl =
    st === 'S3_OBJECT_POLLING'
      ? String(row.endpoint_url ?? row.base_url ?? row.host ?? '').trim()
      : String(row.base_url ?? row.endpoint_url ?? row.host ?? '').trim()

  return {
    connectorName: row.name ?? '',
    description: row.description ?? '',
    hostBaseUrl: baseUrl,
    sourceType: st,
    verifySsl: row.verify_ssl,
    httpProxy: row.http_proxy ?? '',
    commonHeaders,
    authType,
    basicUsername: String(auth.basic_username ?? ''),
    basicPassword: String(auth.basic_password ?? ''),
    bearerToken: String(auth.bearer_token ?? ''),
    apiKeyName: String(auth.api_key_name ?? ''),
    apiKeyValue: String(auth.api_key_value ?? ''),
    apiKeyLocation: (String(auth.api_key_location ?? 'headers').toLowerCase() as ApiKeyLocation),
    oauthClientId: String(auth.oauth2_client_id ?? ''),
    oauthClientSecret: String(auth.oauth2_client_secret ?? ''),
    oauthTokenUrl: String(auth.oauth2_token_url ?? ''),
    oauthScope: String(auth.oauth2_scope ?? ''),
    loginUrl: String(auth.login_url ?? ''),
    loginPath: String(auth.login_path ?? ''),
    loginMethod: (String(auth.login_method ?? 'POST').toUpperCase() as 'POST' | 'PUT' | 'PATCH'),
    loginUsername: String(auth.login_username ?? ''),
    loginPassword: String(auth.login_password ?? ''),
    loginHeaders,
    loginBodyTemplate,
    refreshToken: String(auth.refresh_token ?? ''),
    tokenUrl: String(auth.token_url ?? ''),
    tokenPath: String(auth.token_path ?? ''),
    tokenHttpMethod: (String(auth.token_http_method ?? 'POST').toUpperCase() as 'POST' | 'PUT' | 'PATCH'),
    refreshTokenHeaderName: String(auth.refresh_token_header_name ?? 'Authorization'),
    refreshTokenHeaderPrefix: String(auth.refresh_token_header_prefix ?? 'Bearer'),
    accessTokenJsonPath: String(auth.access_token_json_path ?? '$.access_token'),
    accessTokenHeaderName: String(auth.access_token_header_name ?? 'Authorization'),
    accessTokenHeaderPrefix: String(auth.access_token_header_prefix ?? 'Bearer'),
    tokenTtlSeconds: Number(auth.token_ttl_seconds ?? 600),
  }
}

export type WizardLegacySubstepCompletion = Record<WizardLegacySubstepKey, StepCompletion>

/** True when the wizard has mappable output (basic rows, JSONata, or full-event regex). */
export function wizardMappingContentReady(
  state: Pick<
    WizardState,
    'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson'
  >,
): boolean {
  return (
    state.mapping.filter((m) => m.outputField.trim() && m.sourceJsonPath.trim()).length > 0 ||
    (state.mappingMode === 'full_event_jsonata' && state.fullEventJsonataExpression.trim().length > 0) ||
    (state.mappingMode === 'full_event_regex' &&
      hasValidFullEventRegexConfigJson(state.fullEventRegexConfigJson))
  )
}

/** Display count for Review: basic field rows, or 1 for full-event transform modes. */
export function wizardEffectiveMappedFieldCount(
  state: Pick<
    WizardState,
    'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson'
  >,
): number {
  const basic = state.mapping.filter((m) => m.outputField.trim() && m.sourceJsonPath.trim()).length
  if (basic > 0) return basic
  if (state.mappingMode === 'full_event_jsonata' && state.fullEventJsonataExpression.trim()) return 1
  if (
    state.mappingMode === 'full_event_regex' &&
    hasValidFullEventRegexConfigJson(state.fullEventRegexConfigJson)
  ) {
    return 1
  }
  return 0
}

export type WizardStepCompletion = Record<WizardStepKey, StepCompletion>

function worstCompletion(a: StepCompletion, b: StepCompletion): StepCompletion {
  if (a === 'incomplete' || b === 'incomplete') return 'incomplete'
  if (a === 'in_progress' || b === 'in_progress') return 'in_progress'
  return 'complete'
}

function aggregateCompletion(statuses: StepCompletion[]): StepCompletion {
  if (statuses.length === 0) return 'incomplete'
  return statuses.reduce(worstCompletion, 'complete')
}

/** Per legacy sub-step completion (internal; review/deploy edit shortcuts). */
export function computeLegacySubstepCompletion(state: WizardState): WizardLegacySubstepCompletion {
  const connectorReady = state.connector.connectorId != null && state.connector.sourceId != null
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const isDatabase = state.connector.sourceType === 'DATABASE_QUERY'
  const streamReady =
    state.stream.name.trim().length > 0 &&
    (isS3 ||
      isRemote ||
      isWebhook ||
      isDatabase ||
      (!isS3 && !isRemote && !isWebhook && !isDatabase && state.stream.endpoint.trim().length > 0)) &&
    (!isS3 || (Number.isFinite(state.stream.maxObjectsPerRun) && state.stream.maxObjectsPerRun >= 1)) &&
    (!isRemote || state.stream.remoteDirectory.trim().length > 0) &&
    (!isDatabase || state.stream.sqlQuery.trim().length > 0)
  const apiTestRan =
    state.apiTest.status === 'success' &&
    (!isS3 || state.apiTest.s3ConnectivityPassed) &&
    (!isRemote || state.apiTest.remoteProbe?.ok === true)
  const previewErr = state.apiTest.analysis?.previewError
  const recordsGateReady =
    isRemote || isWebhook
      ? apiTestRan
      : state.apiTest.status === 'success' &&
        state.apiTest.ok &&
        (state.apiTest.parsedJson ?? state.apiTest.rawResponse) != null &&
        (state.apiTest.statusCode == null || state.apiTest.statusCode < 400) &&
        state.apiTest.finishedAt != null &&
        state.stream.recordPathConfirmedForApiTestAt === state.apiTest.finishedAt &&
        state.stream.checkpointConfirmedForApiTestAt === state.apiTest.finishedAt &&
        (state.stream.useWholeResponseAsEvent || state.stream.eventArrayPath.trim().length > 0) &&
        state.stream.checkpointSourcePath.trim().length > 0
  const previewReady = isRemote || isWebhook ? apiTestRan : recordsGateReady && !previewErr
  const mappingReady =
    wizardMappingContentReady(state) ||
    state.transformRules.some((r) => r.outputField.trim()) ||
    ((isRemote || isWebhook) && state.unmappedFieldsPolicy === 'pass_through')
  const enrichmentReady = state.enrichment.length === 0 || state.enrichment.every((e) => e.fieldName.trim().length > 0)
  const enrichmentHasRows = state.enrichment.length > 0
  const destinationsReady = state.destinations.routeDrafts.some((r) => r.enabled)
  const dataProtectionReady = wizardDataProtectionStepComplete(state.dataProtection)
  const reviewReady =
    connectorReady &&
    streamReady &&
    apiTestRan &&
    previewReady &&
    recordsGateReady &&
    mappingReady &&
    destinationsReady &&
    dataProtectionReady
  const created = state.outcome?.streamId != null && reviewReady

  return {
    connector: connectorReady ? 'complete' : 'in_progress',
    stream: !connectorReady ? 'incomplete' : streamReady ? 'complete' : 'in_progress',
    api_test: !connectorReady || !streamReady ? 'incomplete' : apiTestRan ? 'complete' : 'in_progress',
    preview: !connectorReady || !streamReady || !apiTestRan ? 'incomplete' : previewReady ? 'complete' : 'in_progress',
    mapping: !previewReady ? 'incomplete' : mappingReady ? 'complete' : 'in_progress',
    enrichment: !mappingReady ? 'incomplete' : enrichmentReady && enrichmentHasRows ? 'complete' : 'in_progress',
    data_protection: !mappingReady ? 'incomplete' : dataProtectionReady ? 'complete' : 'in_progress',
    destinations: !mappingReady ? 'incomplete' : destinationsReady ? 'complete' : 'in_progress',
    review: created ? 'complete' : reviewReady ? 'in_progress' : 'incomplete',
    done: created ? 'complete' : 'incomplete',
  }
}

/** Stepper completion — aggregates legacy sub-step signals into five top-level steps. */
export function computeStepCompletion(state: WizardState): WizardStepCompletion {
  const legacy = computeLegacySubstepCompletion(state)

  const connect = aggregateCompletion([legacy.connector, legacy.stream, legacy.api_test])
  const sample = legacy.preview
  const destinations = legacy.destinations
  const route_processing = aggregateCompletion([legacy.mapping, legacy.enrichment, legacy.data_protection])
  const deploy = aggregateCompletion([legacy.review, legacy.done])

  return {
    connect,
    sample,
    destinations,
    route_processing,
    deploy,
  }
}

function buildAuthConfig(state: WizardState): Record<string, unknown> {
  const authType = state.connector.authType
  if (authType === 'BASIC') {
    return {
      type: authType,
      username: state.connector.basicUsername,
      password: state.connector.basicPassword,
    }
  }
  if (authType === 'BEARER') {
    return {
      type: authType,
      token: state.connector.bearerToken,
    }
  }
  if (authType === 'API_KEY') {
    return {
      type: authType,
      key_name: state.connector.apiKeyName,
      key_value: state.connector.apiKeyValue,
      location: state.connector.apiKeyLocation,
    }
  }
  if (authType === 'OAUTH2_CLIENT_CREDENTIALS') {
    return {
      type: authType,
      client_id: state.connector.oauthClientId,
      client_secret: state.connector.oauthClientSecret,
      token_url: state.connector.oauthTokenUrl,
      scope: state.connector.oauthScope,
    }
  }
  if (authType === 'SESSION_LOGIN') {
    const lh = state.connector.loginHeaders
    const login_headers =
      lh && Object.keys(lh).length > 0 ? { ...lh } : { 'Content-Type': 'application/json' }
    const tmpl = state.connector.loginBodyTemplate
    const login_body_template =
      tmpl && Object.keys(tmpl).length > 0
        ? tmpl
        : { username: '{{username}}', password: '{{password}}' }
    return {
      type: authType,
      login_url: state.connector.loginUrl || undefined,
      login_path: state.connector.loginPath || undefined,
      login_method: state.connector.loginMethod,
      login_headers,
      login_body_template,
      login_username: state.connector.loginUsername,
      login_password: state.connector.loginPassword,
    }
  }
  if (authType === 'JWT_REFRESH_TOKEN') {
    return {
      type: authType,
      refresh_token: state.connector.refreshToken,
      token_url: state.connector.tokenUrl || undefined,
      token_path: state.connector.tokenPath || undefined,
      token_http_method: state.connector.tokenHttpMethod,
      refresh_token_header_name: state.connector.refreshTokenHeaderName,
      refresh_token_header_prefix: state.connector.refreshTokenHeaderPrefix,
      access_token_json_path: state.connector.accessTokenJsonPath,
      access_token_header_name: state.connector.accessTokenHeaderName,
      access_token_header_prefix: state.connector.accessTokenHeaderPrefix,
      token_ttl_seconds: state.connector.tokenTtlSeconds,
    }
  }
  return { type: 'NO_AUTH' }
}

export function buildSourceConfig(state: WizardState): Record<string, unknown> {
  const commonHeaders: Record<string, string> = {}
  for (const row of state.connector.commonHeaders) {
    if (row.key.trim()) commonHeaders[row.key.trim()] = row.value
  }
  const endpointRaw = state.stream.endpoint.trim()
  let baseUrl = state.connector.hostBaseUrl.trim()
  if (!baseUrl && /^https?:\/\//i.test(endpointRaw)) {
    try {
      baseUrl = new URL(endpointRaw).origin
    } catch {
      // Keep empty base_url and let backend return a precise validation error.
    }
  }
  return {
    base_url: baseUrl,
    timeout_seconds: state.stream.timeoutSec,
    verify_ssl: state.connector.verifySsl,
    http_proxy: state.connector.httpProxy.trim() || null,
    headers: commonHeaders,
  }
}

export function buildSourceAuthPayload(state: WizardState): Record<string, unknown> {
  const auth = buildAuthConfig(state)
  return {
    auth_type: auth.type,
    ...auth,
  }
}

export function buildStreamConfigPayload(state: WizardState): Record<string, unknown> {
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const isDatabase = state.connector.sourceType === 'DATABASE_QUERY'
  if (isRemote) {
    return {
      remote_directory: state.stream.remoteDirectory.trim(),
      file_pattern: (state.stream.filePattern.trim() || '*') as string,
      recursive: state.stream.remoteRecursive,
      parser_type: state.stream.parserType,
      max_files_per_run: Math.max(1, Math.floor(Number(state.stream.maxFilesPerRun) || 10)),
      max_file_size_mb: Math.max(1, Math.floor(Number(state.stream.maxFileSizeMb) || 5)),
      encoding: state.stream.encoding.trim() || 'utf-8',
      csv_delimiter: state.stream.csvDelimiter || ',',
      line_event_field: state.stream.lineEventField.trim() || 'line',
      include_file_metadata: state.stream.includeFileMetadata,
    }
  }
  if (isDatabase) {
    const ckCol = state.stream.dbCheckpointColumn.trim()
    const ckMode = (state.stream.dbCheckpointMode.trim() || (ckCol ? 'SINGLE_COLUMN' : 'NONE')).toUpperCase()
    const out: Record<string, unknown> = {
      query: state.stream.sqlQuery.trim(),
      checkpoint_mode: ckMode,
      timeout_seconds: state.stream.timeoutSec,
    }
    if (ckCol) out.checkpoint_column = ckCol
    return out
  }
  if (isWebhook) {
    const out: Record<string, unknown> = {
      timeout_seconds: state.stream.timeoutSec,
    }
    if (!state.stream.useWholeResponseAsEvent) {
      const eap = state.stream.eventArrayPath.trim()
      if (eap) out.event_array_path = eap.startsWith('$') ? eap : `$.${eap}`
    }
    const erp = state.stream.eventRootPath.trim()
    if (erp) out.event_root_path = erp.startsWith('$') ? erp : `$.${erp}`
    return out
  }
  const headers: Record<string, string> = {}
  for (const row of state.stream.headers) {
    if (row.key.trim()) headers[row.key.trim()] = row.value
  }
  const baseParams: Record<string, string> = {}
  for (const row of state.stream.params) {
    if (row.key.trim()) baseParams[row.key.trim()] = row.value
  }
  const rawEndpoint = state.stream.endpoint.trim()
  let endpoint = rawEndpoint
  if (/^https?:\/\//i.test(rawEndpoint)) {
    try {
      const parsed = new URL(rawEndpoint)
      endpoint = `${parsed.pathname || '/'}${parsed.search || ''}`
    } catch {
      endpoint = rawEndpoint
    }
  }
  const out: Record<string, unknown> = {
    method: state.stream.httpMethod,
    endpoint,
    headers,
    params: baseParams,
    body: state.stream.requestBody.trim() || undefined,
    timeout_seconds: state.stream.timeoutSec,
  }
  if (!state.stream.useWholeResponseAsEvent) {
    const eap = state.stream.eventArrayPath.trim()
    if (eap) {
      out.event_array_path = eap.startsWith('$') ? eap : `$.${eap}`
    }
  }
  const erp = state.stream.eventRootPath.trim()
  if (erp) {
    out.event_root_path = erp.startsWith('$') ? erp : `$.${erp}`
  }
  return out
}

/**
 * Build stream_config for incremental-request Test only.
 * This applies incremental templates at request time without mutating persisted
 * Connect-step request body/params.
 */
export function buildIncrementalTestStreamConfigPayload(state: WizardState): Record<string, unknown> {
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const isDatabase = state.connector.sourceType === 'DATABASE_QUERY'
  if (isRemote || isWebhook || isDatabase) {
    return buildStreamConfigPayload(state)
  }
  const base = buildStreamConfigPayload(state)
  const merged = applyIncrementalRequestTemplate(
    {
      method: String(base.method ?? state.stream.httpMethod),
      params: ((base.params as Record<string, string> | undefined) ?? {}) as Record<string, string>,
      body: typeof base.body === 'string' ? base.body : undefined,
    },
    state.stream.incrementalRequestPattern,
    state.stream.incrementalRequestDraft,
  )
  return {
    ...base,
    method: merged.method,
    params: merged.params,
    body: merged.body,
  }
}

export function buildStreamCreatePayload(state: WizardState): {
  name: string
  connector_id: number
  source_id: number
  stream_type: string
  polling_interval: number
  enabled: boolean
  status: string
  config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
} | null {
  if (state.connector.connectorId == null || state.connector.sourceId == null) return null
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const isDatabase = state.connector.sourceType === 'DATABASE_QUERY'
  const maxOb = Math.max(1, Math.floor(Number(state.stream.maxObjectsPerRun) || 20))
  let stream_type = 'HTTP_API_POLLING'
  if (isS3) stream_type = 'S3_OBJECT_POLLING'
  else if (isRemote) stream_type = 'REMOTE_FILE_POLLING'
  else if (isWebhook) stream_type = 'WEBHOOK_RECEIVER'
  else if (isDatabase) stream_type = 'DATABASE_QUERY'
  const config_json: Record<string, unknown> = isS3
    ? { max_objects_per_run: maxOb }
    : mergeStreamConfigJson(
        {},
        buildStreamConfigPayload(state),
        isDatabase ? {} : buildAdvancedStreamConfigJsonPatch(state.stream),
      )
  return {
    name: state.stream.name.trim() || 'Untitled Stream',
    connector_id: state.connector.connectorId,
    source_id: state.connector.sourceId,
    stream_type,
    polling_interval: state.stream.pollingIntervalSec,
    // Create ≠ Start: wizard create must leave the stream stopped until explicit Start.
    enabled: false,
    status: 'STOPPED',
    config_json,
    rate_limit_json: {
      per_minute: state.stream.rateLimitPerMinute,
      burst: state.stream.rateLimitBurst,
    },
  }
}

export function fieldMappingsFromRows(rows: WizardMappingRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    if (row.outputField.trim() && row.sourceJsonPath.trim()) {
      out[row.outputField.trim()] = row.sourceJsonPath.trim()
    }
  }
  return out
}

/** Persisted field_mappings_json for the active wizard mapping mode. */
export function buildWizardFieldMappingsPayload(
  state: Pick<
    WizardState,
    | 'mapping'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'transformRules'
    | 'unmappedFieldsPolicy'
  >,
): Record<string, unknown> {
  if (state.mappingMode === 'full_event_jsonata') {
    const expr = state.fullEventJsonataExpression.trim()
    if (!expr) return {}
    return buildWizardJsonataPreviewFieldMappings(expr)
  }
  if (state.mappingMode === 'full_event_regex') {
    const built = buildFieldMappingsFromFullEventRegexConfigJson(state.fullEventRegexConfigJson)
    if (!built.ok) return {}
    return built.fieldMappings
  }
  return buildFieldMappingsWithTransformRules(
    fieldMappingsFromRows(state.mapping),
    state.transformRules,
    state.unmappedFieldsPolicy,
  )
}

export function wizardFieldMappingsReady(
  state: Pick<
    WizardState,
    'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson' | 'transformRules'
  >,
): boolean {
  if (state.mappingMode === 'full_event_jsonata') {
    return state.fullEventJsonataExpression.trim().length > 0
  }
  if (state.mappingMode === 'full_event_regex') {
    return hasValidFullEventRegexConfigJson(state.fullEventRegexConfigJson)
  }
  return (
    Object.keys(fieldMappingsFromRows(state.mapping)).length > 0 ||
    state.transformRules.some((r) => r.outputField.trim())
  )
}

/** Resolve a draft's server route id from an explicit draft-key map, else `route-N` key. */
export function resolveWizardRouteDraftId(
  draft: WizardRouteDraft,
  routeIdsByDraftKey: Record<string, number>,
): number | null {
  const mapped = routeIdsByDraftKey[draft.key]
  if (typeof mapped === 'number' && Number.isFinite(mapped) && mapped > 0) return mapped
  const match = /^route-(\d+)$/.exec(draft.key)
  if (!match) return null
  const id = Number(match[1])
  return Number.isFinite(id) && id > 0 ? id : null
}

export type RouteTransformMappingPersistAction =
  | { inherit: true }
  | { inherit: false; fieldMappings: Record<string, unknown> }

export type RouteTransformEnrichmentPersistAction =
  | { inherit: true }
  | { inherit: false; enrichment: Record<string, unknown> }

export type RouteTransformPersistPlan = {
  routeId: number
  mapping: RouteTransformMappingPersistAction
  enrichment: RouteTransformEnrichmentPersistAction
}

/** Mapping/enrichment payload for a route Transform override draft, or null when empty/incomplete. */
export function routeTransformOverridePersistPayload(
  override: WizardRouteTransformOverride | undefined,
): { fieldMappings: Record<string, unknown>; enrichment: Record<string, unknown> } | null {
  if (!override) return null
  const fieldMappings = buildWizardFieldMappingsPayload(override)
  const enrichment = enrichmentDictFromRows(override.enrichment)
  if (Object.keys(fieldMappings).length === 0 && Object.keys(enrichment).length === 0) return null
  return { fieldMappings, enrichment }
}

/** True when the draft will persist a complete route Transform override (not Intent only). */
export function hasPersistableRouteTransformOverride(draft: WizardRouteDraft): boolean {
  return (
    draft.inherit.transform === false &&
    routeTransformOverridePersistPayload(draft.overrides?.transform) != null
  )
}

/**
 * Expected Effective API processing_status after persisting the given mapping/enrichment payload.
 * Mapping-only or enrichment-only → Mixed; both → Overridden.
 */
export function expectedRouteTransformProcessingStatus(
  fieldMappings: Record<string, unknown>,
  enrichment: Record<string, unknown>,
): 'Overridden' | 'Mixed' {
  const hasMapping = Object.keys(fieldMappings).length > 0
  const hasEnrichment = Object.keys(enrichment).length > 0
  if (hasMapping && hasEnrichment) return 'Overridden'
  return 'Mixed'
}

/**
 * Plans route mapping/enrichment saves so Inherited / Mixed / Overridden stay truthful.
 * - inherit.transform → clear both subcomponents (`inherit: true`)
 * - mapping-only / enrichment-only → override the present side and clear the other
 * - incomplete Intent-only override → skipped
 *
 * Route ids are keyed by draft key so partial create failures cannot shift bindings.
 */
export function buildRouteTransformPersistPlans(
  drafts: WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): RouteTransformPersistPlan[] {
  const plans: RouteTransformPersistPlan[] = []
  for (const draft of drafts) {
    const routeId = resolveWizardRouteDraftId(draft, routeIdsByDraftKey)
    if (routeId == null) continue

    if (draft.inherit.transform !== false) {
      plans.push({
        routeId,
        mapping: { inherit: true },
        enrichment: { inherit: true },
      })
      continue
    }

    const payload = routeTransformOverridePersistPayload(draft.overrides?.transform)
    if (!payload) continue

    const hasMapping = Object.keys(payload.fieldMappings).length > 0
    const hasEnrichment = Object.keys(payload.enrichment).length > 0
    plans.push({
      routeId,
      mapping: hasMapping
        ? { inherit: false, fieldMappings: payload.fieldMappings }
        : { inherit: true },
      enrichment: hasEnrichment
        ? { inherit: false, enrichment: payload.enrichment }
        : { inherit: true },
    })
  }
  return plans
}

export function buildRouteCreatePayloads(streamId: number, destinations: WizardDestinationsState): Array<{
  stream_id: number
  destination_id: number
  enabled: boolean
  failure_policy: WizardRouteDraft['failurePolicy']
  status: 'ENABLED' | 'DISABLED'
  formatter_config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
}> {
  const tmpl =
    destinations.messagePrefixTemplate.trim().length > 0
      ? destinations.messagePrefixTemplate.trim()
      : DEFAULT_MESSAGE_PREFIX_TEMPLATE
  return destinations.routeDrafts.map((draft) => {
    const destinationId = draft.destinationId
    const kind = destinations.destinationKindsById[destinationId]
    const explicit = destinations.messagePrefixEnabledByDestinationId[destinationId]
    const prefixEnabled = explicit !== undefined ? explicit : defaultMessagePrefixEnabled(kind ?? '')
    const rl = draft.rateLimitJson && typeof draft.rateLimitJson === 'object' ? { ...draft.rateLimitJson } : {}
    return {
      stream_id: streamId,
      destination_id: destinationId,
      enabled: draft.enabled,
      failure_policy: draft.failurePolicy,
      status: draft.enabled ? 'ENABLED' : 'DISABLED',
      formatter_config_json: {
        message_prefix_enabled: prefixEnabled,
        message_prefix_template: tmpl,
      },
      rate_limit_json: rl,
    }
  })
}
