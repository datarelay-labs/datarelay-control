import { fetchConnectorById } from '../../../api/gdcConnectors'
import { fetchDestinationsList } from '../../../api/gdcDestinations'
import { fetchRoutesList, type RouteRead } from '../../../api/gdcRoutes'
import {
  fetchRouteEnrichmentUiConfig,
  fetchRouteMappingUiConfig,
  type RouteEnrichmentUiConfig,
  type RouteMappingUiConfig,
} from '../../../api/gdcRouteTransform'
import { fetchStreamMappingUiConfig } from '../../../api/gdcRuntime'
import { fetchStreamById } from '../../../api/gdcStreams'
import { fetchStreamProtectionRules, type ProtectionMode } from '../../../api/gdcProtection'
import type { MappingUIConfigResponse, MappingUIConfigRouteItem, StreamRead } from '../../../api/types/gdcApi'
import { resolveStreamEndpointPath } from '../../../utils/streamHttpConfigFromStreamRead'
import { unionSchemaFromStreamConfig } from '../../../utils/unionSchema'
import {
  parseTransformRulesFromFieldMappings,
  UNMAPPED_FIELDS_POLICY_KEY,
} from '../../../utils/advancedTransformConfig'
import type { MappingMode } from '../../../types/advancedTransform'
import { DEFAULT_MESSAGE_PREFIX_TEMPLATE, defaultMessagePrefixEnabled } from '../../../utils/messagePrefixDefaults'
import {
  normalizeWizardEnrichmentRules,
  wizardEnrichmentFromPersistedDict,
  wizardEnrichmentRulesFromPersistedDict,
} from './enrichment-rules-model'
import { fullEventRegexConfigJsonFromFieldMappings } from './wizard-full-event-regex-config'
import {
  readAdvancedStreamConfigFromPersisted,
} from './wizard-stream-config-sync'
import { hydrateRouteGovernanceDrafts } from './wizard-route-governance-bundle'
import {
  inferIncrementalRequestPattern,
  type IncrementalRequestPattern,
} from './wizard-incremental-request'
import {
  buildInitialState,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  normalizeUnknownNormalFieldPolicy,
  normalizeUnknownSensitiveFieldPolicy,
  normalizeWizardDestinations,
  wizardConnectorPatchFromApi,
  type StreamConfigHeaderRow,
  type WizardMappingRow,
  type WizardRouteDraft,
  type WizardRouteTransformOverride,
  type WizardState,
} from './wizard-state'

function protectionModeToWizardAction(mode: ProtectionMode): WizardState['dataProtection']['intents'][number]['protectionAction'] {
  if (mode === 'partial_mask') return 'mask_partial'
  if (mode === 'full_mask') return 'mask_full'
  if (mode === 'tokenization') return 'tokenize'
  if (mode === 'hash') return 'hash'
  return 'drop_field'
}

function kvRowsFromRecord(raw: Record<string, unknown> | undefined, prefix: string): StreamConfigHeaderRow[] {
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw).map(([key, value], index) => ({
    id: `${prefix}-${index}`,
    key,
    value: String(value ?? ''),
  }))
}

function stripJsonPathPrefix(path: string | null | undefined): string {
  const trimmed = String(path ?? '').trim()
  if (!trimmed) return ''
  return trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed
}

function enrichmentRulesFromServer(raw: unknown) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return wizardEnrichmentRulesFromPersistedDict(raw as Record<string, unknown>)
  }
  return normalizeWizardEnrichmentRules(raw)
}

function enrichmentMetadataFromServer(
  enrichment: MappingUIConfigResponse['enrichment'],
): Pick<WizardState, 'enrichment' | 'enrichmentEnabled' | 'enrichmentOverridePolicy' | 'enrichmentPassthrough'> {
  const raw = enrichment?.enrichment
  const parsed =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? wizardEnrichmentFromPersistedDict(raw) : null
  const policy = enrichment?.override_policy
  const enrichmentOverridePolicy: WizardState['enrichmentOverridePolicy'] =
    policy === 'OVERRIDE' || policy === 'ERROR_ON_CONFLICT' || policy === 'KEEP_EXISTING' ? policy : undefined
  return {
    enrichment: parsed?.rules ?? enrichmentRulesFromServer(raw),
    enrichmentEnabled: enrichment?.enabled,
    enrichmentOverridePolicy,
    enrichmentPassthrough: parsed?.advancedPassthrough,
  }
}

function rateLimitPatchFromRead(rateLimit: Record<string, unknown> | null | undefined): Partial<WizardState['stream']> {
  const rl = rateLimit ?? {}
  const unknown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rl)) {
    if (key === 'max_events' || key === 'per_seconds' || key === 'per_minute' || key === 'burst') continue
    unknown[key] = value
  }
  let rateLimitPerMinute = 60
  if (typeof rl.max_events === 'number' && typeof rl.per_seconds === 'number' && rl.per_seconds > 0) {
    rateLimitPerMinute = Math.round(rl.max_events * (60 / rl.per_seconds))
  } else if (typeof rl.per_minute === 'number') {
    rateLimitPerMinute = rl.per_minute
  }
  return {
    rateLimitPerMinute,
    rateLimitBurst: typeof rl.burst === 'number' ? rl.burst : 10,
    rateLimitUnknownKeys: unknown,
  }
}

function readSchemaDriftPolicy(cfg: Record<string, unknown>):
  | { ok: true; policy: { unknownNormalFieldPolicy: ReturnType<typeof normalizeUnknownNormalFieldPolicy>; unknownSensitiveFieldPolicy: ReturnType<typeof normalizeUnknownSensitiveFieldPolicy> } | null }
  | { ok: false } {
  const governance = cfg.governance
  if (governance == null) return { ok: true, policy: null }
  if (typeof governance !== 'object' || Array.isArray(governance)) return { ok: false }
  if (!('schema_drift_policy' in governance)) return { ok: true, policy: null }
  const policy = (governance as Record<string, unknown>).schema_drift_policy
  if (policy == null) return { ok: true, policy: null }
  if (typeof policy !== 'object' || Array.isArray(policy)) return { ok: false }
  const raw = policy as Record<string, unknown>
  return {
    ok: true,
    policy: {
      unknownNormalFieldPolicy: normalizeUnknownNormalFieldPolicy(raw.unknown_normal_field_policy),
      unknownSensitiveFieldPolicy: normalizeUnknownSensitiveFieldPolicy(raw.unknown_sensitive_field_policy),
    },
  }
}

function sourceSpecificStreamPatch(cfg: Record<string, unknown>): Partial<WizardState['stream']> {
  const patch: Partial<WizardState['stream']> = {}
  if (typeof cfg.remote_directory === 'string') patch.remoteDirectory = cfg.remote_directory
  if (typeof cfg.file_pattern === 'string') patch.filePattern = cfg.file_pattern
  if (typeof cfg.recursive === 'boolean') patch.remoteRecursive = cfg.recursive
  if (typeof cfg.parser_type === 'string') patch.parserType = cfg.parser_type
  if (typeof cfg.max_files_per_run === 'number') patch.maxFilesPerRun = cfg.max_files_per_run
  if (typeof cfg.max_file_size_mb === 'number') patch.maxFileSizeMb = cfg.max_file_size_mb
  if (typeof cfg.encoding === 'string') patch.encoding = cfg.encoding
  if (typeof cfg.csv_delimiter === 'string') patch.csvDelimiter = cfg.csv_delimiter
  if (typeof cfg.line_event_field === 'string') patch.lineEventField = cfg.line_event_field
  if (typeof cfg.include_file_metadata === 'boolean') patch.includeFileMetadata = cfg.include_file_metadata
  if (typeof cfg.max_objects_per_run === 'number') patch.maxObjectsPerRun = cfg.max_objects_per_run
  if (typeof cfg.query === 'string') patch.sqlQuery = cfg.query
  if (typeof cfg.checkpoint_column === 'string') patch.dbCheckpointColumn = cfg.checkpoint_column
  if (typeof cfg.checkpoint_mode === 'string') patch.dbCheckpointMode = cfg.checkpoint_mode
  return patch
}

function mappingRowsFromFieldMappings(fieldMappings: Record<string, unknown>): WizardMappingRow[] {
  const rows: WizardMappingRow[] = []
  let index = 0
  for (const [outputField, sourcePath] of Object.entries(fieldMappings)) {
    if (outputField === 'transform_rules' || outputField === 'mapping_mode' || outputField === UNMAPPED_FIELDS_POLICY_KEY) {
      continue
    }
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) continue
    rows.push({
      id: `map-${index++}`,
      outputField,
      sourceJsonPath: sourcePath.trim(),
      origin: 'manual',
    })
  }
  return rows
}

export function wizardMappingStateFromUiConfig(mapping: MappingUIConfigResponse): WizardState {
  const base = buildInitialState()
  const fieldMappings = (mapping.mapping?.field_mappings ?? {}) as Record<string, unknown>
  const unmappedPolicyRaw = fieldMappings[UNMAPPED_FIELDS_POLICY_KEY]
  return {
    ...base,
    mapping: mappingRowsFromFieldMappings(fieldMappings),
    mappingMode: mappingModeFromFieldMappings(fieldMappings),
    fullEventJsonataExpression: fullEventJsonataExpressionFromFieldMappings(fieldMappings),
    fullEventRegexConfigJson: fullEventRegexConfigJsonFromFieldMappings(fieldMappings),
    unmappedFieldsPolicy: unmappedPolicyRaw === 'drop_unmapped' ? 'drop_unmapped' : 'pass_through',
    transformRules: parseTransformRulesFromFieldMappings(fieldMappings),
    ...enrichmentMetadataFromServer(mapping.enrichment),
    mappingRawPayloadMode: mapping.mapping?.raw_payload_mode ?? null,
  }
}

function mappingModeFromFieldMappings(fieldMappings: Record<string, unknown>): MappingMode {
  const mode = fieldMappings.mapping_mode
  if (mode === 'full_event_jsonata') return 'full_event_jsonata'
  if (mode === 'full_event_regex') return 'full_event_regex'
  return 'basic_jsonpath'
}

/** Read persisted full-event JSONata expression (`jsonata_expression`; legacy `expression` fallback). */
export function fullEventJsonataExpressionFromFieldMappings(fieldMappings: Record<string, unknown>): string {
  if (mappingModeFromFieldMappings(fieldMappings) !== 'full_event_jsonata') return ''
  const raw = fieldMappings.jsonata_expression ?? fieldMappings.expression
  return typeof raw === 'string' ? raw : ''
}

function normalizeFailurePolicy(raw: string): WizardRouteDraft['failurePolicy'] {
  const upper = raw.toUpperCase()
  if (upper === 'PAUSE_STREAM_ON_FAILURE') return 'PAUSE_STREAM_ON_FAILURE'
  if (upper === 'RETRY_AND_BACKOFF') return 'RETRY_AND_BACKOFF'
  if (upper === 'DISABLE_ROUTE_ON_FAILURE') return 'DISABLE_ROUTE_ON_FAILURE'
  return 'LOG_AND_CONTINUE'
}

function formatterFields(
  raw: Record<string, unknown> | null | undefined,
): Pick<WizardRouteDraft, 'formatterConfig' | 'messagePrefixEnabled' | 'messagePrefixTemplate'> {
  const formatterConfig = raw && typeof raw === 'object' ? { ...raw } : {}
  return {
    formatterConfig,
    messagePrefixEnabled:
      typeof formatterConfig.message_prefix_enabled === 'boolean' ? formatterConfig.message_prefix_enabled : undefined,
    messagePrefixTemplate:
      typeof formatterConfig.message_prefix_template === 'string' ? formatterConfig.message_prefix_template : undefined,
  }
}

function routeDraftFromMappingItem(route: MappingUIConfigRouteItem, updatedAt?: string | null): WizardRouteDraft {
  return {
    key: `route-${route.route_id}`,
    destinationId: route.destination_id,
    enabled: route.route_enabled,
    failurePolicy: normalizeFailurePolicy(route.failure_policy),
    rateLimitJson:
      route.route_rate_limit && typeof route.route_rate_limit === 'object'
        ? { ...(route.route_rate_limit as Record<string, unknown>) }
        : {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    updatedAt: updatedAt ?? null,
    ...formatterFields(route.formatter_config),
  }
}

function routeDraftFromCatalogRoute(route: RouteRead): WizardRouteDraft {
  return {
    key: `route-${route.id}`,
    destinationId: route.destination_id ?? 0,
    enabled: route.enabled !== false,
    failurePolicy: normalizeFailurePolicy(route.failure_policy ?? 'LOG_AND_CONTINUE'),
    rateLimitJson:
      route.rate_limit_json && typeof route.rate_limit_json === 'object'
        ? { ...route.rate_limit_json }
        : {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    overrides: undefined,
    updatedAt: route.updated_at ?? null,
    ...formatterFields(route.formatter_config_json ?? undefined),
  }
}

function unmappedFieldsPolicyFromFieldMappings(
  fieldMappings: Record<string, unknown>,
): WizardRouteTransformOverride['unmappedFieldsPolicy'] {
  const raw = fieldMappings[UNMAPPED_FIELDS_POLICY_KEY]
  return raw === 'drop_unmapped' ? 'drop_unmapped' : 'pass_through'
}

/**
 * Apply persisted route mapping/enrichment UI configs onto a wizard route draft so
 * edit-save Effective verification expects Inherited / Mixed / Overridden truthfully.
 *
 * Callers must pass successfully read configs only. Null/`safeRequestJson` failure
 * must not be coerced to Inherited (that would clear persisted overrides on save).
 */
export function applyRouteTransformConfigsToDraft(
  draft: WizardRouteDraft,
  mappingCfg: RouteMappingUiConfig,
  enrichmentCfg: RouteEnrichmentUiConfig,
): WizardRouteDraft {
  const inheritMapping = mappingCfg.inherit_stream_mapping
  const inheritEnrichment = enrichmentCfg.inherit_stream_enrichment
  const inheritTransform = inheritMapping && inheritEnrichment

  if (inheritTransform) {
    const restOverrides = draft.overrides ? { ...draft.overrides } : undefined
    if (restOverrides) delete restOverrides.transform
    return {
      ...draft,
      inherit: { ...draft.inherit, transform: true },
      overrides: restOverrides && Object.keys(restOverrides).length > 0 ? restOverrides : undefined,
    }
  }

  const fieldMappings = !inheritMapping
    ? ((mappingCfg.mapping?.field_mappings ?? {}) as Record<string, unknown>)
    : {}
  const enrichmentRec = !inheritEnrichment
    ? ((enrichmentCfg.enrichment?.enrichment ?? {}) as Record<string, unknown>)
    : {}
  const overridePolicyRaw = enrichmentCfg.enrichment?.override_policy
  const enrichmentOverridePolicy =
    overridePolicyRaw === 'OVERRIDE' ||
    overridePolicyRaw === 'ERROR_ON_CONFLICT' ||
    overridePolicyRaw === 'KEEP_EXISTING'
      ? overridePolicyRaw
      : 'KEEP_EXISTING'
  const enrichmentParsed = wizardEnrichmentFromPersistedDict(enrichmentRec)
  const transform: WizardRouteTransformOverride = {
    mapping: mappingRowsFromFieldMappings(fieldMappings),
    mappingMode: mappingModeFromFieldMappings(fieldMappings),
    fullEventJsonataExpression: fullEventJsonataExpressionFromFieldMappings(fieldMappings),
    fullEventRegexConfigJson: fullEventRegexConfigJsonFromFieldMappings(fieldMappings),
    transformRules: parseTransformRulesFromFieldMappings(fieldMappings),
    enrichment: enrichmentParsed.rules,
    mappingRowPresent: !inheritMapping,
    enrichmentRowPresent: !inheritEnrichment,
    enrichmentEnabled: !inheritEnrichment ? enrichmentCfg.enrichment?.enabled !== false : undefined,
    enrichmentOverridePolicy: !inheritEnrichment ? enrichmentOverridePolicy : undefined,
    ...(Object.keys(enrichmentParsed.advancedPassthrough).length > 0
      ? { enrichmentAdvancedPassthrough: enrichmentParsed.advancedPassthrough }
      : {}),
    ...(enrichmentParsed.emitAdvancedAsTypeArray
      ? { enrichmentEmitAdvancedAsTypeArray: true }
      : {}),
    ...(!inheritMapping ? { rawPayloadMode: mappingCfg.mapping?.raw_payload_mode ?? null } : {}),
    unmappedFieldsPolicy: unmappedFieldsPolicyFromFieldMappings(fieldMappings),
  }

  return {
    ...draft,
    inherit: { ...draft.inherit, transform: false },
    overrides: {
      ...draft.overrides,
      transform,
    },
  }
}

export type RouteTransformHydrateApplyResult =
  | { ok: true; draft: WizardRouteDraft }
  | { ok: false; error: string }

/**
 * Fail closed when mapping or enrichment config read failed (`safeRequestJson` → null).
 * Never default a failed read to Inherited.
 */
export function tryApplyRouteTransformConfigsToDraft(
  draft: WizardRouteDraft,
  mappingCfg: RouteMappingUiConfig | null,
  enrichmentCfg: RouteEnrichmentUiConfig | null,
): RouteTransformHydrateApplyResult {
  const routeLabel = draft.key.startsWith('route-') ? draft.key.slice('route-'.length) : draft.key
  if (mappingCfg == null && enrichmentCfg == null) {
    return {
      ok: false,
      error: `route ${routeLabel} transform: mapping and enrichment config read failed; refusing to default to Inherited`,
    }
  }
  if (mappingCfg == null) {
    return {
      ok: false,
      error: `route ${routeLabel} transform: mapping config read failed; refusing to default to Inherited`,
    }
  }
  if (enrichmentCfg == null) {
    return {
      ok: false,
      error: `route ${routeLabel} transform: enrichment config read failed; refusing to default to Inherited`,
    }
  }
  return { ok: true, draft: applyRouteTransformConfigsToDraft(draft, mappingCfg, enrichmentCfg) }
}

export type RouteTransformDraftsHydrateResult =
  | { ok: true; drafts: WizardRouteDraft[] }
  | { ok: false; errors: string[] }

/** Hydrate Transform for existing route drafts; fail closed on any config read failure. */
export async function hydrateRouteDraftsTransform(
  drafts: WizardRouteDraft[],
): Promise<RouteTransformDraftsHydrateResult> {
  const errors: string[] = []
  const next: WizardRouteDraft[] = []

  for (const draft of drafts) {
    const routeId = Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN)
    if (!Number.isFinite(routeId) || routeId <= 0) {
      next.push(draft)
      continue
    }
    const [mappingCfg, enrichmentCfg] = await Promise.all([
      fetchRouteMappingUiConfig(routeId),
      fetchRouteEnrichmentUiConfig(routeId),
    ])
    const applied = tryApplyRouteTransformConfigsToDraft(draft, mappingCfg, enrichmentCfg)
    if (applied.ok === false) {
      errors.push(applied.error)
      continue
    }
    next.push(applied.draft)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, drafts: next }
}

/** Merge mapping-ui routes with catalog routes so edit wizard shows persisted delivery paths. */
export function buildWizardDestinationsFromRouteSources(
  mappingRoutes: readonly MappingUIConfigRouteItem[],
  catalogRoutes: readonly RouteRead[],
  destinations: ReadonlyArray<{ id: number; destination_type?: string | null }>,
): WizardState['destinations'] {
  const destinationKindsById: Record<number, string> = {}
  const messagePrefixEnabledByDestinationId: Record<number, boolean> = {}
  const destById = new Map(destinations.map((d) => [d.id, d]))
  const catalogById = new Map(catalogRoutes.map((route) => [route.id, route]))
  const seenRouteIds = new Set<number>()
  const routeDrafts: WizardRouteDraft[] = []
  let messagePrefixTemplate = DEFAULT_MESSAGE_PREFIX_TEMPLATE

  for (const route of mappingRoutes) {
    seenRouteIds.add(route.route_id)
    const destinationType = route.destination_type ?? destById.get(route.destination_id)?.destination_type ?? ''
    destinationKindsById[route.destination_id] = destinationType
    const fc = route.formatter_config ?? {}
    messagePrefixEnabledByDestinationId[route.destination_id] =
      typeof fc.message_prefix_enabled === 'boolean'
        ? fc.message_prefix_enabled
        : defaultMessagePrefixEnabled(destinationType)
    const prefixTemplate = fc.message_prefix_template
    if (typeof prefixTemplate === 'string' && prefixTemplate.trim()) {
      messagePrefixTemplate = prefixTemplate.trim()
    }
    routeDrafts.push(routeDraftFromMappingItem(route, catalogById.get(route.route_id)?.updated_at))
  }

  for (const route of catalogRoutes) {
    if (seenRouteIds.has(route.id)) continue
    const destinationId = route.destination_id ?? 0
    if (destinationId <= 0) continue
    const destinationType = destById.get(destinationId)?.destination_type ?? ''
    destinationKindsById[destinationId] = destinationType
    const formatter = route.formatter_config_json ?? {}
    if (messagePrefixEnabledByDestinationId[destinationId] === undefined) {
      messagePrefixEnabledByDestinationId[destinationId] =
        typeof formatter.message_prefix_enabled === 'boolean'
          ? formatter.message_prefix_enabled
          : defaultMessagePrefixEnabled(destinationType)
    }
    const prefixTemplate = formatter.message_prefix_template
    if (
      messagePrefixTemplate === DEFAULT_MESSAGE_PREFIX_TEMPLATE &&
      typeof prefixTemplate === 'string' &&
      prefixTemplate.trim()
    ) {
      messagePrefixTemplate = prefixTemplate.trim()
    }
    routeDrafts.push(routeDraftFromCatalogRoute(route))
  }

  routeDrafts.sort((a, b) => {
    const aId = Number(/^route-(\d+)$/.exec(a.key)?.[1] ?? 0)
    const bId = Number(/^route-(\d+)$/.exec(b.key)?.[1] ?? 0)
    return aId - bId
  })

  return normalizeWizardDestinations({
    routeDrafts,
    destinationKindsById,
    messagePrefixEnabledByDestinationId,
    messagePrefixTemplate,
    destinationApiBacked: true,
  })
}

async function withHydratedRouteTransforms(
  streamId: number,
  destinations: WizardState['destinations'],
): Promise<WizardState['destinations'] | null> {
  const hydrated = await hydrateRouteDraftsTransform(destinations.routeDrafts)
  if (!hydrated.ok) return null
  const withGovernance = await hydrateRouteGovernanceDrafts(streamId, hydrated.drafts)
  return normalizeWizardDestinations({
    ...destinations,
    routeDrafts: withGovernance,
  })
}

export type WizardDestinationsRefresh = {
  destinations: WizardState['destinations']
  routeIds: number[]
}

export async function refreshWizardDestinationsFromStream(streamId: number): Promise<WizardDestinationsRefresh | null> {
  const [mapping, allRoutes, destinations] = await Promise.all([
    fetchStreamMappingUiConfig(streamId, { fresh: true }),
    fetchRoutesList(),
    fetchDestinationsList(),
  ])
  if (allRoutes == null || destinations === null) return null
  const streamRoutes = allRoutes.filter((route) => route.stream_id === streamId)
  const merged = await withHydratedRouteTransforms(
    streamId,
    buildWizardDestinationsFromRouteSources(mapping?.routes ?? [], streamRoutes, destinations),
  )
  if (merged == null) return null
  const routeIds = merged.routeDrafts
    .map((draft) => Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN))
    .filter((id): id is number => Number.isFinite(id))
  return { destinations: merged, routeIds }
}

const INCREMENTAL_REQUEST_PATTERNS = new Set<IncrementalRequestPattern>([
  'none',
  'custom',
  'query_params',
  'json_body',
  'elasticsearch',
  'visualsearch_query',
])

function normalizedHttpMethod(value: unknown, fallback: string): WizardState['stream']['httpMethod'] {
  const raw = String(value ?? fallback).trim().toUpperCase()
  return raw === 'POST' || raw === 'PUT' || raw === 'PATCH' || raw === 'DELETE' ? raw : 'GET'
}

function incrementalRequestPatchFromPersisted(
  cfg: Record<string, unknown>,
  endpoint: string,
  httpMethod: string,
  requestBody: string,
): Partial<WizardState['stream']> {
  const params =
    cfg.params && typeof cfg.params === 'object' && !Array.isArray(cfg.params)
      ? (cfg.params as Record<string, unknown>)
      : {}
  const runtimeUi =
    cfg.runtime_ui && typeof cfg.runtime_ui === 'object' && !Array.isArray(cfg.runtime_ui)
      ? (cfg.runtime_ui as Record<string, unknown>)
      : {}
  const metadata =
    runtimeUi.incremental_request &&
    typeof runtimeUi.incremental_request === 'object' &&
    !Array.isArray(runtimeUi.incremental_request)
      ? (runtimeUi.incremental_request as Record<string, unknown>)
      : null

  if (metadata) {
    const rawPattern = String(metadata.pattern ?? '').trim() as IncrementalRequestPattern
    if (INCREMENTAL_REQUEST_PATTERNS.has(rawPattern)) {
      const baseParams =
        metadata.base_params && typeof metadata.base_params === 'object' && !Array.isArray(metadata.base_params)
          ? (metadata.base_params as Record<string, unknown>)
          : {}
      const baseBody = typeof metadata.base_body === 'string' ? metadata.base_body : ''
      return {
        httpMethod: normalizedHttpMethod(metadata.base_method, httpMethod),
        params: kvRowsFromRecord(baseParams, 'prm'),
        requestBody: baseBody,
        incrementalRequestPattern: rawPattern,
        incrementalRequestDraft: typeof metadata.draft === 'string' ? metadata.draft : '',
      }
    }
  }

  const queryRows = Object.entries(params).filter(([, value]) =>
    /\{\{(?:checkpoint\.|runtime\.|now\}\})/i.test(String(value ?? '')),
  )
  if (queryRows.some(([, value]) => /\{\{checkpoint\./i.test(String(value ?? '')))) {
    const generatedKeys = new Set(queryRows.map(([key]) => key))
    const baseParams = Object.fromEntries(Object.entries(params).filter(([key]) => !generatedKeys.has(key)))
    return {
      params: kvRowsFromRecord(baseParams, 'prm'),
      incrementalRequestPattern: 'query_params',
      incrementalRequestDraft: queryRows.map(([key, value]) => `${key}=${String(value ?? '')}`).join('\n'),
    }
  }

  if (/\{\{checkpoint\./i.test(requestBody)) {
    return {
      requestBody: '',
      incrementalRequestPattern:
        inferIncrementalRequestPattern({ endpoint, requestBody, httpMethod }) ?? 'json_body',
      incrementalRequestDraft: requestBody,
    }
  }
  return {}
}

function streamConfigPatchFromRead(
  found: StreamRead,
  mapping: MappingUIConfigResponse | null,
): Partial<WizardState['stream']> {
  const cfg = (found.config_json ?? {}) as Record<string, unknown>
  const sourceConfig = mapping?.source_config ?? {}
  const methodRaw = String(cfg.method ?? cfg.http_method ?? 'GET').toUpperCase()
  const httpMethod =
    methodRaw === 'POST' ||
    methodRaw === 'PUT' ||
    methodRaw === 'PATCH' ||
    methodRaw === 'DELETE'
      ? methodRaw
      : 'GET'
  const endpoint = resolveStreamEndpointPath(cfg, sourceConfig)
  const body = cfg.body ?? cfg.request_body
  let requestBody = ''
  if (typeof body === 'string') requestBody = body
  else if (body != null) {
    try {
      requestBody = JSON.stringify(body, null, 2)
    } catch {
      requestBody = ''
    }
  }

  const eventArrayPath = stripJsonPathPrefix(mapping?.mapping?.event_array_path)
  const eventRootPath = stripJsonPathPrefix(mapping?.mapping?.event_root_path)
  const advanced = readAdvancedStreamConfigFromPersisted(cfg, mapping?.mapping ?? null)
  const useWholeResponseAsEvent =
    advanced.useWholeResponseAsEvent ??
    (!eventArrayPath && !mapping?.mapping?.event_array_path)

  const rl = found.rate_limit_json ?? {}
  const confirmedAt = Date.now()
  const checkpointSourcePath = advanced.checkpointSourcePath ?? ''
  const checkpointFieldType = advanced.checkpointFieldType ?? ''
  const recordSelectionMode = advanced.recordSelectionMode ?? 'basic'

  return {
    name: (found.name ?? '').trim() || `Stream ${found.id}`,
    httpMethod,
    endpoint,
    headers: kvRowsFromRecord((cfg.headers ?? {}) as Record<string, unknown>, 'hdr'),
    params: kvRowsFromRecord((cfg.params ?? {}) as Record<string, unknown>, 'prm'),
    requestBody,
    ...incrementalRequestPatchFromPersisted(cfg, endpoint, httpMethod, requestBody),
    pollingIntervalSec:
      typeof found.polling_interval === 'number' && found.polling_interval > 0 ? found.polling_interval : 60,
    timeoutSec:
      mapping?.source_type === 'DATABASE_QUERY'
        ? typeof cfg.query_timeout_seconds === 'number'
          ? cfg.query_timeout_seconds
          : typeof cfg.timeout_seconds === 'number'
            ? cfg.timeout_seconds
            : typeof cfg.timeout_sec === 'number'
              ? cfg.timeout_sec
              : 30
        : typeof cfg.timeout_seconds === 'number'
          ? cfg.timeout_seconds
          : typeof cfg.timeout_sec === 'number'
            ? cfg.timeout_sec
            : 30,
    ...sourceSpecificStreamPatch(cfg),
    eventArrayPath: advanced.eventArrayPath ?? eventArrayPath,
    eventRootPath: advanced.eventRootPath ?? eventRootPath,
    useWholeResponseAsEvent,
    checkpointSourcePath,
    checkpointFieldType,
    checkpointMode: advanced.checkpointMode ?? 'Cursor',
    checkpointSecondaryPath: advanced.checkpointSecondaryPath ?? '',
    recordSelectionMode,
    customExtractionValidatedForApiTestAt: recordSelectionMode === 'advanced' ? confirmedAt : null,
    customExtractionValidationOk: recordSelectionMode !== 'advanced' ? false : true,
    schemaRootPath: advanced.schemaRootPath ?? '',
    initialDelaySec: advanced.initialDelaySec ?? 0,
    paginationType: advanced.paginationType ?? 'None',
    paginationCursorParam: advanced.paginationCursorParam ?? '',
    paginationPageSize: advanced.paginationPageSize ?? 0,
    paginationMaxPages: advanced.paginationMaxPages ?? 0,
    ...rateLimitPatchFromRead(rl),
    recordPathConfirmedForApiTestAt:
      (advanced.eventArrayPath ?? eventArrayPath) || useWholeResponseAsEvent ? confirmedAt : null,
    eventRootConfirmedForApiTestAt: (advanced.eventRootPath ?? eventRootPath) ? confirmedAt : null,
    checkpointConfirmedForApiTestAt: checkpointSourcePath ? confirmedAt : null,
  }
}

export async function hydrateWizardStateFromStream(streamId: number): Promise<WizardState | null> {
  const [found, mapping, allRoutes, destinations] = await Promise.all([
    fetchStreamById(streamId),
    fetchStreamMappingUiConfig(streamId, { fresh: true }),
    fetchRoutesList(),
    fetchDestinationsList(),
  ])
  if (!found || mapping == null) return null
  const schemaDrift = readSchemaDriftPolicy((found.config_json ?? {}) as Record<string, unknown>)
  if (!schemaDrift.ok) return null

  const streamRoutes = (allRoutes ?? []).filter((route) => route.stream_id === streamId)
  if (destinations === null) return null
  const hydratedDestinations = await withHydratedRouteTransforms(
    streamId,
    buildWizardDestinationsFromRouteSources(mapping?.routes ?? [], streamRoutes, destinations),
  )
  if (hydratedDestinations == null) return null
  const hydratedRouteIds = hydratedDestinations.routeDrafts
    .map((draft) => Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN))
    .filter((id): id is number => Number.isFinite(id))

  const base = buildInitialState()
  const connectorId = typeof found.connector_id === 'number' ? found.connector_id : null
  let connectorPatch: Partial<WizardState['connector']> = {
    connectorId,
    sourceId: mapping?.source_id ?? null,
    apiBacked: true,
  }

  if (connectorId != null) {
    const connector = await fetchConnectorById(connectorId)
    if (connector) {
      connectorPatch = {
        ...connectorPatch,
        ...wizardConnectorPatchFromApi(connector),
        connectorId,
        sourceId: connector.source_id ?? mapping?.source_id ?? null,
      }
    }
  }

  const protectionRules = await fetchStreamProtectionRules(streamId, true)

  const fieldMappings = (mapping?.mapping?.field_mappings ?? {}) as Record<string, unknown>
  const mappingMode = mappingModeFromFieldMappings(fieldMappings)
  const fullEventJsonataExpression = fullEventJsonataExpressionFromFieldMappings(fieldMappings)
  const fullEventRegexConfigJson = fullEventRegexConfigJsonFromFieldMappings(fieldMappings)

  const unmappedPolicyRaw = fieldMappings[UNMAPPED_FIELDS_POLICY_KEY]
  const unmappedFieldsPolicy = unmappedPolicyRaw === 'drop_unmapped' ? 'drop_unmapped' : 'pass_through'

  return {
    ...base,
    connector: {
      ...base.connector,
      ...connectorPatch,
      sourceType:
        (mapping?.source_type as WizardState['connector']['sourceType']) ??
        connectorPatch.sourceType ??
        base.connector.sourceType,
    },
    stream: {
      ...base.stream,
      ...streamConfigPatchFromRead(found, mapping),
    },
    apiTest: {
      ...base.apiTest,
      unionSchema: unionSchemaFromStreamConfig((found.config_json ?? {}) as Record<string, unknown>),
    },
    mapping: mappingRowsFromFieldMappings(fieldMappings),
    mappingMode,
    fullEventJsonataExpression,
    fullEventRegexConfigJson,
    unmappedFieldsPolicy,
    transformRules: parseTransformRulesFromFieldMappings(fieldMappings),
    ...enrichmentMetadataFromServer(mapping.enrichment),
    mappingRawPayloadMode: mapping.mapping?.raw_payload_mode ?? null,
    streamUpdatedAt: found.updated_at ?? null,
    destinations: hydratedDestinations,
    dataProtection: {
      ...base.dataProtection,
      ...(schemaDrift.policy ?? {}),
      intents: (protectionRules?.rules ?? []).map((rule) => ({
        key: 'persisted-protection-' + rule.id,
        detectedField: rule.field_path,
        protectionAction: protectionModeToWizardAction(rule.protection_mode),
        deliveryBehavior: 'continue' as const,
      })),
    },
    outcome: {
      streamId: found.id,
      routeId: hydratedRouteIds[0] ?? null,
      routeIds: hydratedRouteIds,
      mappingSaved: mapping?.mapping?.exists ?? false,
      enrichmentSaved: mapping?.enrichment?.exists ?? false,
      dataProtectionSaved: false,
      governanceSaved: false,
      schemaDriftPolicySaved: false,
      schemaDriftPolicyWarnings: [],
      dataProtectionEnforcementIncomplete: false,
      dataProtectionWarnings: [],
      errors: [],
      apiBacked: true,
      createdAt: found.created_at ?? null,
      materializedStreamIds: [],
    },
  }
}
