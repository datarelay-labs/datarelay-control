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
import type { MappingUIConfigResponse, MappingUIConfigRouteItem, StreamRead } from '../../../api/types/gdcApi'
import { resolveStreamEndpointPath } from '../../../utils/streamHttpConfigFromStreamRead'
import {
  parseTransformRulesFromFieldMappings,
  UNMAPPED_FIELDS_POLICY_KEY,
} from '../../../utils/advancedTransformConfig'
import type { MappingMode } from '../../../types/advancedTransform'
import { DEFAULT_MESSAGE_PREFIX_TEMPLATE, defaultMessagePrefixEnabled } from '../../../utils/messagePrefixDefaults'
import {
  normalizeWizardEnrichmentRules,
  wizardEnrichmentFromPersistedDict,
} from './enrichment-rules-model'
import { fullEventRegexConfigJsonFromFieldMappings } from './wizard-full-event-regex-config'
import {
  readAdvancedStreamConfigFromPersisted,
} from './wizard-stream-config-sync'
import {
  buildInitialState,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  normalizeWizardDestinations,
  wizardConnectorPatchFromApi,
  type StreamConfigHeaderRow,
  type WizardMappingRow,
  type WizardRouteDraft,
  type WizardRouteTransformOverride,
  type WizardState,
} from './wizard-state'

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

function routeDraftFromMappingItem(route: MappingUIConfigRouteItem): WizardRouteDraft {
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
    routeDrafts.push(routeDraftFromMappingItem(route))
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
  destinations: WizardState['destinations'],
): Promise<WizardState['destinations'] | null> {
  const hydrated = await hydrateRouteDraftsTransform(destinations.routeDrafts)
  if (!hydrated.ok) return null
  return normalizeWizardDestinations({
    ...destinations,
    routeDrafts: hydrated.drafts,
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
  const streamRoutes = (allRoutes ?? []).filter((route) => route.stream_id === streamId)
  if (destinations === null) return null
  const merged = await withHydratedRouteTransforms(
    buildWizardDestinationsFromRouteSources(mapping?.routes ?? [], streamRoutes, destinations),
  )
  if (merged == null) return null
  const routeIds = merged.routeDrafts
    .map((draft) => Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN))
    .filter((id): id is number => Number.isFinite(id))
  return { destinations: merged, routeIds }
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
    pollingIntervalSec:
      typeof found.polling_interval === 'number' && found.polling_interval > 0 ? found.polling_interval : 60,
    timeoutSec:
      typeof cfg.timeout_seconds === 'number'
        ? cfg.timeout_seconds
        : typeof cfg.timeout_sec === 'number'
          ? cfg.timeout_sec
          : 30,
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
    rateLimitPerMinute: typeof rl.per_minute === 'number' ? rl.per_minute : 60,
    rateLimitBurst: typeof rl.burst === 'number' ? rl.burst : 10,
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
  if (!found) return null

  const streamRoutes = (allRoutes ?? []).filter((route) => route.stream_id === streamId)
  if (destinations === null) return null
  const hydratedDestinations = await withHydratedRouteTransforms(
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
    mapping: mappingRowsFromFieldMappings(fieldMappings),
    mappingMode,
    fullEventJsonataExpression,
    fullEventRegexConfigJson,
    unmappedFieldsPolicy,
    enrichment: normalizeWizardEnrichmentRules(mapping?.enrichment?.enrichment),
    destinations: hydratedDestinations,
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
