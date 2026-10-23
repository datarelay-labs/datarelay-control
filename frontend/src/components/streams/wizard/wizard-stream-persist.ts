import { fetchStreamClassificationRules } from '../../../api/gdcClassification'
import { fetchStreamPolicyRules } from '../../../api/gdcPolicy'
import { fetchStreamProtectionRules } from '../../../api/gdcProtection'
import { createRoute, deleteRoute, fetchRouteByIdFresh, updateRoute, updateRouteWithFreshToken } from '../../../api/gdcRoutes'
import { fetchStreamGovernance } from '../../../api/gdcStreamGovernance'
import {
  fetchRouteTransformEffective,
  saveRouteEnrichmentUiConfig,
  saveRouteMappingUiConfig,
} from '../../../api/gdcRouteTransform'
import { saveStreamMappingUiConfigStrict } from '../../../api/gdcRuntimeUi'
import { fetchStreamByIdFresh, updateStream } from '../../../api/gdcStreams'
import {
  applyExplicitCheckpointClear,
  applyExplicitEventPathClear,
  buildAdvancedStreamConfigJsonPatch,
  mergeStreamConfigJson,
} from './wizard-stream-config-sync'
import {
  buildRouteCreatePayloads,
  buildRouteTransformPersistPlans,
  buildPersistedStreamConfigPayload,
  buildStreamCreatePayload,
  buildWizardFieldMappingsPayload,
  enrichmentDictFromRows,
  expectedRouteTransformProcessingStatus,
  routeTransformOverridePersistPayload,
  wizardFieldMappingsReady,
  type WizardRouteDraft,
  type WizardState,
} from './wizard-state'
import { persistWizardDataProtectionIntents } from './wizard-data-protection-persist'
import { mergeSchemaDriftPolicyIntoConfigJson } from './wizard-schema-drift-policy-persist'
import { persistWizardStreamGovernance } from './wizard-governance-persist'
import {
  persistWizardRouteGovernanceBundles,
  verifyWizardRouteGovernanceEffective,
} from './wizard-route-governance-bundle'

export type WizardStreamPersistResult = {
  ok: boolean
  errors: string[]
  /** Client draft key to server route id for creates/updates that succeeded. */
  routeIdsByDraftKey: Record<string, number>
  /** Present when the stream update used the merge-read token and the server accepted it. */
  streamUpdatedAt?: string | null
  /** New Route.updated_at for drafts whose broad update succeeded. */
  routeUpdatedAtByDraftKey?: Record<string, string>
  /** True when this call created Data Protection rules that must become the confirmed concern. */
  dataProtectionPersisted?: boolean
  /** Server-acknowledged objects before an eventual later failure. */
  persistedObjects: string[]
  /** Objects or concerns that were not confirmed by this save attempt. */
  notPersistedObjects: string[]
}

export type SyncRoutesResult = {
  errors: string[]
  /** Server route id keyed by draft key (existing `route-N` or newly created). */
  routeIdsByDraftKey: Record<string, number>
  routeUpdatedAtByDraftKey: Record<string, string>
  persistedObjects: string[]
  notPersistedObjects: string[]
}

export type ReviewedRevisionPreflightResult = {
  errors: string[]
  stream: Awaited<ReturnType<typeof fetchStreamByIdFresh>>
}

function routeKeyToId(key: string): number | null {
  const match = /^route-(\d+)$/.exec(key)
  if (!match) return null
  const id = Number(match[1])
  return Number.isFinite(id) ? id : null
}

function normalizedRevision(value: string | null | undefined): string | null {
  const revision = typeof value === 'string' ? value.trim() : ''
  return revision || null
}

/**
 * Validate every reviewed server-owned revision before the first write.
 * This closes the gap where a fresh GET token could silently turn an old browser
 * draft into a current write and catches stale multi-Route edits before an earlier
 * object has already been persisted. Server-side row locks remain authoritative
 * for races that occur after this preflight.
 */
export async function preflightWizardReviewedRevision(
  streamId: number,
  state: WizardState,
  confirmedState?: WizardState | null,
): Promise<ReviewedRevisionPreflightResult> {
  const errors: string[] = []
  const reviewedStreamToken = normalizedRevision(state.streamUpdatedAt)
  const stream = await fetchStreamByIdFresh(streamId)
  if (stream == null) {
    errors.push(`stream ${streamId}: current server revision could not be read; reviewed configuration was not applied.`)
  } else if (!reviewedStreamToken) {
    errors.push(`stream ${streamId}: reviewed revision token is missing; reviewed configuration was not applied.`)
  } else if (normalizedRevision(stream.updated_at) !== reviewedStreamToken) {
    errors.push(
      `stream ${streamId}: STREAM_STALE_WRITE — reviewed revision ${reviewedStreamToken} no longer matches the current server revision. Refresh before applying.`,
    )
  }

  const reviewedRoutes = new Map<number, WizardRouteDraft>()
  for (const draft of [...(confirmedState?.destinations.routeDrafts ?? []), ...state.destinations.routeDrafts]) {
    const routeId = routeKeyToId(draft.key)
    if (routeId != null) reviewedRoutes.set(routeId, draft)
  }
  for (const [routeId, draft] of reviewedRoutes) {
    const reviewedToken = normalizedRevision(draft.updatedAt)
    if (!reviewedToken) {
      errors.push(`route ${routeId}: reviewed concurrency token is missing; no configuration was written.`)
      continue
    }
    const current = await fetchRouteByIdFresh(routeId)
    if (current == null) {
      errors.push(`route ${routeId}: current server revision could not be read; no configuration was written.`)
      continue
    }
    if (
      (current.stream_id != null && current.stream_id !== streamId) ||
      (current.destination_id != null && current.destination_id !== draft.destinationId)
    ) {
      errors.push(
        `route ${routeId}: reviewed dependency changed (Stream/Destination mismatch); refresh before applying.`,
      )
      continue
    }
    if (normalizedRevision(current.updated_at) !== reviewedToken) {
      errors.push(
        `route ${routeId}: ROUTE_STALE_WRITE — reviewed revision ${reviewedToken} no longer matches the current server revision. Refresh before applying.`,
      )
    }
  }
  return { errors, stream }
}

export async function syncRoutes(
  streamId: number,
  state: WizardState,
  options?: { confirmedState?: WizardState | null },
): Promise<SyncRoutesResult> {
  const errors: string[] = []
  const persistedObjects: string[] = []
  const notPersistedObjects: string[] = []
  const routeIdsByDraftKey: Record<string, number> = {}
  const routeUpdatedAtByDraftKey: Record<string, string> = {}
  const payloads = buildRouteCreatePayloads(streamId, state.destinations)

  for (const [index, draft] of state.destinations.routeDrafts.entries()) {
    const routeId = routeKeyToId(draft.key)
    const payload = payloads[index]
    if (!payload || payload.destination_id !== draft.destinationId) {
      errors.push(`route ${draft.key}: could not match a payload for this draft`)
      continue
    }

    try {
      if (routeId != null) {
        if (!draft.updatedAt) {
          errors.push(`route ${routeId}: concurrency token is missing, so this draft was not written.`)
          continue
        }
        const updated = await updateRoute(routeId, {
          stream_id: streamId,
          enabled: payload.enabled,
          failure_policy: payload.failure_policy,
          status: payload.status,
          rate_limit_json: payload.rate_limit_json,
          formatter_config_json: payload.formatter_config_json,
          expected_updated_at: draft.updatedAt,
        })
        routeIdsByDraftKey[draft.key] = routeId
        persistedObjects.push(`Route #${routeId}`)
        if (updated.updated_at) routeUpdatedAtByDraftKey[draft.key] = updated.updated_at
      } else {
        const created = await createRoute(payload)
        routeIdsByDraftKey[draft.key] = created.id
        persistedObjects.push(`Route #${created.id}`)
      }
    } catch (err) {
      errors.push(`route ${draft.destinationId}: ${err instanceof Error ? err.message : String(err)}`)
      notPersistedObjects.push(routeId == null ? `Route for Destination #${draft.destinationId}` : `Route #${routeId}`)
    }
  }

  const protectedIds = new Set<number>()
  for (const draft of state.destinations.routeDrafts) {
    const existingId = routeKeyToId(draft.key)
    if (existingId != null) protectedIds.add(existingId)
  }
  const keptIds = new Set(Object.values(routeIdsByDraftKey))
  const priorRouteIds = options?.confirmedState != null
    ? options.confirmedState.destinations.routeDrafts
        .map((draft) => routeKeyToId(draft.key))
        .filter((routeId): routeId is number => routeId != null)
    : (state.outcome?.routeIds ?? [])
  for (const priorId of priorRouteIds) {
    if (keptIds.has(priorId) || protectedIds.has(priorId)) continue
    const reviewedPrior = options?.confirmedState?.destinations.routeDrafts.find(
      (candidate) => routeKeyToId(candidate.key) === priorId,
    )
    try {
      if (reviewedPrior?.updatedAt) {
        await updateRoute(priorId, {
          stream_id: streamId,
          enabled: false,
          status: 'DISABLED',
          expected_updated_at: reviewedPrior.updatedAt,
        })
      } else if (options?.confirmedState != null) {
        throw new Error(`reviewed concurrency token is missing for Route #${priorId}`)
      } else {
        // Standalone/create compatibility path. Stream Edit always supplies confirmedState
        // and therefore never upgrades a reviewed deletion to a fresh-token write.
        await updateRouteWithFreshToken(priorId, {
          stream_id: streamId,
          enabled: false,
          status: 'DISABLED',
        })
      }
    } catch (err) {
      errors.push(`disable route ${priorId}: ${err instanceof Error ? err.message : String(err)}`)
      notPersistedObjects.push(`Route #${priorId} removal`)
      continue
    }
    try {
      await deleteRoute(priorId)
      persistedObjects.push(`Route #${priorId} removal`)
    } catch (err) {
      errors.push(`delete route ${priorId}: ${err instanceof Error ? err.message : String(err)}`)
      notPersistedObjects.push(`Route #${priorId} removal`)
    }
  }

  return { errors, routeIdsByDraftKey, routeUpdatedAtByDraftKey, persistedObjects, notPersistedObjects }
}

export function applyPersistedRevisions(
  state: WizardState,
  revisions: { streamUpdatedAt?: string | null; routeUpdatedAtByDraftKey?: Record<string, string> },
): WizardState {
  const routeUpdatedAtByDraftKey = revisions.routeUpdatedAtByDraftKey ?? {}
  const routeDrafts = state.destinations.routeDrafts.map((draft) => {
    const nextToken = routeUpdatedAtByDraftKey[draft.key]
    return nextToken ? { ...draft, updatedAt: nextToken } : draft
  })
  return {
    ...state,
    streamUpdatedAt: revisions.streamUpdatedAt ?? state.streamUpdatedAt,
    destinations: { ...state.destinations, routeDrafts },
  }
}

/** Keep a newly created server id on the current draft without copying the rest of the saved snapshot. */
export function applyCreatedRouteIdentity(
  state: WizardState,
  routeIdsByDraftKey: Record<string, number>,
): WizardState {
  let changed = false
  const keyRemap = new Map<string, string>()
  const routeDrafts = state.destinations.routeDrafts.map((draft) => {
    const serverId = routeIdsByDraftKey[draft.key]
    if (serverId == null) return draft
    const nextKey = `route-${serverId}`
    if (draft.key === nextKey) return draft
    changed = true
    keyRemap.set(draft.key, nextKey)
    return { ...draft, key: nextKey }
  })
  const remapRouteDraftKey = <T extends { routeDraftKey: string }>(row: T): T => {
    const nextKey = keyRemap.get(row.routeDraftKey)
    return nextKey == null ? row : { ...row, routeDraftKey: nextKey }
  }
  const nextIds = [...(state.outcome?.routeIds ?? [])]
  for (const id of Object.values(routeIdsByDraftKey)) {
    if (!nextIds.includes(id)) {
      nextIds.push(id)
      changed = true
    }
  }
  if (!changed) return state
  const dataProtection =
    keyRemap.size === 0
      ? state.dataProtection
      : {
          ...state.dataProtection,
          routeOverrides: state.dataProtection.routeOverrides.map(remapRouteDraftKey),
          routeClassificationOverrides: state.dataProtection.routeClassificationOverrides.map(remapRouteDraftKey),
        }
  return {
    ...state,
    destinations: { ...state.destinations, routeDrafts },
    dataProtection,
    outcome: state.outcome
      ? { ...state.outcome, routeIds: nextIds, routeId: state.outcome.routeId ?? nextIds[0] ?? null }
      : state.outcome,
  }
}

export async function persistWizardRouteTransformOverrides(
  drafts: WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): Promise<string[]> {
  const errors: string[] = []
  for (const plan of buildRouteTransformPersistPlans(drafts, routeIdsByDraftKey)) {
    try {
      const mappingAction = plan.mapping
      if (mappingAction.inherit === true) {
        await saveRouteMappingUiConfig(plan.routeId, { inherit: true })
      } else {
        const mappingBody: {
          field_mappings: Record<string, unknown>
          raw_payload_mode?: string | null
        } = { field_mappings: mappingAction.fieldMappings }
        if (mappingAction.rawPayloadMode !== undefined) {
          mappingBody.raw_payload_mode = mappingAction.rawPayloadMode
        }
        await saveRouteMappingUiConfig(plan.routeId, {
          inherit: false,
          mapping: mappingBody,
        })
      }
    } catch (err) {
      errors.push(
        `route ${plan.routeId} mapping: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    try {
      const enrichmentAction = plan.enrichment
      if (enrichmentAction.inherit === true) {
        await saveRouteEnrichmentUiConfig(plan.routeId, { inherit: true })
      } else {
        await saveRouteEnrichmentUiConfig(plan.routeId, {
          inherit: false,
          enrichment: {
            enabled: enrichmentAction.enabled,
            enrichment: enrichmentAction.enrichment,
            override_policy: enrichmentAction.override_policy,
          },
        })
      }
    } catch (err) {
      errors.push(
        `route ${plan.routeId} enrichment: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return errors
}

/**
 * Read back Transform Effective for routes with known ids and fail closed on mismatch.
 * Inherited routes must stay Inherited. Complete overrides must match Overridden/Mixed.
 * Incomplete (Intent only) overrides are not claimed as persisted — skipped here.
 */
export async function verifyWizardRouteTransformEffective(
  drafts: WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): Promise<string[]> {
  const errors: string[] = []

  for (const draft of drafts) {
    const routeId = routeIdsByDraftKey[draft.key] ?? routeKeyToId(draft.key)
    if (routeId == null || routeId <= 0) continue

    const inheritTransform = draft.inherit.transform !== false
    const payload = inheritTransform
      ? null
      : routeTransformOverridePersistPayload(draft.overrides?.transform)

    // Intent-only empty override: do not claim persisted/effective success.
    if (!inheritTransform && payload == null) continue

    const expectedStatus = inheritTransform
      ? ('Inherited' as const)
      : expectedRouteTransformProcessingStatus(payload!.fieldMappings, payload!.enrichment, {
          enrichmentRowPresent: payload!.enrichmentRowPresent,
          mappingRowPresent: payload!.mappingRowPresent,
        })

    let effective
    try {
      effective = await fetchRouteTransformEffective(routeId)
    } catch (err) {
      errors.push(
        `route ${routeId} transform effective: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    if (effective == null) {
      errors.push(
        `route ${routeId} transform: Effective API returned no result (expected ${expectedStatus})`,
      )
      continue
    }

    if (effective.processing_status !== expectedStatus) {
      errors.push(
        `route ${routeId} transform: expected ${expectedStatus} after save, Effective API returned ${effective.processing_status}`,
      )
    }
  }

  return errors
}

export type WizardStreamEditPersistOptions = {
  /** Last confirmed edit state. Required to tell a real clear from an unchanged empty draft. */
  confirmedState?: WizardState | null
}

export async function persistWizardStreamEdits(
  streamId: number,
  state: WizardState,
  options?: WizardStreamEditPersistOptions,
): Promise<WizardStreamPersistResult> {
  const errors: string[] = []
  const payload = buildStreamCreatePayload(state)
  if (payload == null) {
    return {
      ok: false,
      errors: ['Connector and source are required before saving.'],
      routeIdsByDraftKey: {},
      routeUpdatedAtByDraftKey: {},
      dataProtectionPersisted: false,
      persistedObjects: [],
      notPersistedObjects: ['Stream configuration'],
    }
  }

  const confirmed = options?.confirmedState ?? null
  const persistedObjects: string[] = []
  const notPersistedObjects: string[] = []
  const preflight = await preflightWizardReviewedRevision(streamId, state, confirmed)
  if (preflight.errors.length > 0) {
    return {
      ok: false,
      errors: preflight.errors,
      routeIdsByDraftKey: {},
      routeUpdatedAtByDraftKey: {},
      streamUpdatedAt: state.streamUpdatedAt ?? null,
      dataProtectionPersisted: false,
      persistedObjects: [],
      notPersistedObjects: ['Reviewed Stream/Route configuration'],
    }
  }

  let streamUpdatedAt: string | null = null
  try {
    const existing = preflight.stream
    const token = normalizedRevision(state.streamUpdatedAt)
    if (existing == null || !token) {
      errors.push('stream: reviewed concurrency token is missing, so this draft was not written.')
      notPersistedObjects.push(`Stream #${streamId}`)
    } else {
      const existingConfig =
        existing?.config_json && typeof existing.config_json === 'object' && !Array.isArray(existing.config_json)
          ? (existing.config_json as Record<string, unknown>)
          : {}
      const sourcePayload =
        state.connector.sourceType === 'S3_OBJECT_POLLING' ? payload.config_json : buildPersistedStreamConfigPayload(state)
      const mergedConfig = mergeStreamConfigJson(
        existingConfig,
        sourcePayload,
        applyExplicitCheckpointClear(
          buildAdvancedStreamConfigJsonPatch(state.stream),
          confirmed?.stream,
          state.stream,
        ),
      )
      const eventPaths = applyExplicitEventPathClear(mergedConfig, confirmed?.stream, state.stream)
      const config_json = mergeSchemaDriftPolicyIntoConfigJson(eventPaths.config, state.dataProtection)
      if (
        (eventPaths.clearArray || eventPaths.clearRoot) &&
        !wizardFieldMappingsReady(state) &&
        ((eventPaths.clearArray && typeof existingConfig.event_array_path !== 'string') ||
          (eventPaths.clearRoot && typeof existingConfig.event_root_path !== 'string'))
      ) {
        errors.push(
          'stream: clearing an extraction path stored only on mapping, without field mappings, is not confirmed. Existing server mapping paths were not changed.',
        )
      }
      const updated = await updateStream(streamId, {
        name: payload.name,
        polling_interval: payload.polling_interval,
        stream_type: payload.stream_type,
        config_json,
        rate_limit_json: payload.rate_limit_json,
        expected_updated_at: token,
      })
      streamUpdatedAt = updated.updated_at ?? token
      persistedObjects.push(`Stream #${streamId}`)
    }
  } catch (err) {
    errors.push(`stream: ${err instanceof Error ? err.message : String(err)}`)
    notPersistedObjects.push(`Stream #${streamId}`)
  }

  // A Stream CAS can fail after the preflight GET if another writer advances
  // its revision. Without a confirmed Stream save, do not persist Mapping,
  // Route or Governance fragments of this now-stale draft.
  if (streamUpdatedAt == null) {
    return {
      ok: false,
      errors,
      routeIdsByDraftKey: {},
      routeUpdatedAtByDraftKey: {},
      streamUpdatedAt: state.streamUpdatedAt ?? null,
      dataProtectionPersisted: false,
      persistedObjects,
      notPersistedObjects,
    }
  }

  const fieldMappings = buildWizardFieldMappingsPayload(state)
  const enrichmentDict = enrichmentDictFromRows(state.enrichment, {
    advancedPassthrough: state.enrichmentPassthrough,
  })
  const hasMapping = wizardFieldMappingsReady(state)
  const hasEnrichment = Object.keys(enrichmentDict).length > 0

  const priorHadMapping = confirmed != null && wizardFieldMappingsReady(confirmed)
  const priorHadEnrichment = confirmed != null && Object.keys(enrichmentDictFromRows(confirmed.enrichment, {
    advancedPassthrough: confirmed.enrichmentPassthrough,
  })).length > 0
  const clearMapping = confirmed != null && !hasMapping && priorHadMapping
  const clearEnrichment = confirmed != null && !hasEnrichment && priorHadEnrichment
  const enrichmentSignature = (candidate: WizardState) =>
    JSON.stringify({
      rules: candidate.enrichment,
      enabled: candidate.enrichmentEnabled ?? true,
      policy: candidate.enrichmentOverridePolicy ?? 'KEEP_EXISTING',
      passthrough: candidate.enrichmentPassthrough ?? {},
    })
  const enrichmentUnchanged = confirmed != null && enrichmentSignature(confirmed) === enrichmentSignature(state)
  if (clearMapping || clearEnrichment) {
    errors.push(
      'mapping-ui: clearing saved stream mapping or enrichment is not supported. Existing server values were not changed and this draft is not confirmed.',
    )
  }
  const sendEnrichment = !clearEnrichment && hasEnrichment && !enrichmentUnchanged
  if ((!clearMapping && hasMapping) || sendEnrichment) {
    try {
      await saveStreamMappingUiConfigStrict(streamId, {
        mapping:
          !clearMapping && hasMapping
            ? {
                field_mappings: fieldMappings,
                raw_payload_mode: state.mappingRawPayloadMode ?? null,
                event_array_path:
                  state.stream.useWholeResponseAsEvent || !state.stream.eventArrayPath.trim()
                    ? null
                    : state.stream.eventArrayPath.trim().startsWith('$')
                      ? state.stream.eventArrayPath.trim()
                      : `$.${state.stream.eventArrayPath.trim()}`,
                event_root_path: state.stream.eventRootPath.trim()
                  ? state.stream.eventRootPath.trim().startsWith('$')
                    ? state.stream.eventRootPath.trim()
                    : `$.${state.stream.eventRootPath.trim()}`
                  : null,
              }
            : null,
        enrichment:
          sendEnrichment
            ? {
                enabled: state.enrichmentEnabled ?? true,
                enrichment: enrichmentDictFromRows(state.enrichment, {
                  advancedPassthrough: state.enrichmentPassthrough,
                }),
                override_policy: state.enrichmentOverridePolicy ?? 'KEEP_EXISTING',
              }
            : null,
      })
      persistedObjects.push(`Stream #${streamId} Mapping/Enrichment`)
    } catch (err) {
      errors.push(`mapping-ui: ${err instanceof Error ? err.message : String(err)}`)
      notPersistedObjects.push(`Stream #${streamId} Mapping/Enrichment`)
    }
  }

  const synced = await syncRoutes(streamId, state, { confirmedState: confirmed })
  errors.push(...synced.errors)
  persistedObjects.push(...synced.persistedObjects)
  notPersistedObjects.push(...synced.notPersistedObjects)
  // Only routes whose broad reviewed-revision sync succeeded may receive downstream
  // Transform/Governance writes. Helpers intentionally support `route-N` fallback for
  // create/standalone callers, so the reviewed edit flow filters failed routes first.
  const routeIdsByDraftKey: Record<string, number> = { ...synced.routeIdsByDraftKey }
  const persistedRouteDrafts = state.destinations.routeDrafts.filter(
    (draft) => routeIdsByDraftKey[draft.key] != null,
  )
  const routeSafeState: WizardState = {
    ...state,
    destinations: { ...state.destinations, routeDrafts: persistedRouteDrafts },
  }
  errors.push(
    ...(await persistWizardRouteTransformOverrides(persistedRouteDrafts, routeIdsByDraftKey)),
  )
  errors.push(
    ...(await verifyWizardRouteTransformEffective(persistedRouteDrafts, routeIdsByDraftKey)),
  )
  errors.push(
    ...(await persistWizardRouteGovernanceBundles(persistedRouteDrafts, routeIdsByDraftKey)),
  )

  const protection = await persistEditDataProtection(streamId, state, confirmed)
  if (protection.error) errors.push(protection.error)

  try {
    const governanceResult = await persistWizardStreamGovernance(streamId, routeSafeState, routeIdsByDraftKey)
    if (!governanceResult.saved) errors.push(...governanceResult.errors)
    else if (governanceResult.streamUpdatedAt) streamUpdatedAt = governanceResult.streamUpdatedAt
  } catch (err) {
    errors.push(`governance: ${err instanceof Error ? err.message : String(err)}`)
  }
  errors.push(
    ...(await verifyWizardRouteGovernanceEffective(
      persistedRouteDrafts,
      routeIdsByDraftKey,
      state.dataProtection,
    )),
  )

  if (errors.length > 0) {
    for (const error of errors) {
      const label = error.split(':', 1)[0]?.trim()
      if (label && !notPersistedObjects.includes(label)) notPersistedObjects.push(label)
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    routeIdsByDraftKey,
    routeUpdatedAtByDraftKey: synced.routeUpdatedAtByDraftKey,
    streamUpdatedAt,
    dataProtectionPersisted: protection.persisted,
    persistedObjects: [...new Set(persistedObjects)],
    notPersistedObjects: [...new Set(notPersistedObjects)],
  }
}

function dataProtectionIntentKey(state: WizardState | null): string {
  return JSON.stringify(state?.dataProtection.intents ?? [])
}

/**
 * Edit-mode Data Protection must not blindly create rules.
 * Unchanged intent is skipped. A real change or clear stays unconfirmed unless there is
 * no prior intent to replace, because policy/classification rows have no durable wizard owner.
 */
async function existingDataProtectionBlocksCreate(streamId: number): Promise<string | null> {
  let policy: Awaited<ReturnType<typeof fetchStreamPolicyRules>>
  let classification: Awaited<ReturnType<typeof fetchStreamClassificationRules>>
  let protection: Awaited<ReturnType<typeof fetchStreamProtectionRules>>
  let governance: Awaited<ReturnType<typeof fetchStreamGovernance>>
  try {
    ;[policy, classification, protection, governance] = await Promise.all([
      fetchStreamPolicyRules(streamId),
      fetchStreamClassificationRules(streamId),
      fetchStreamProtectionRules(streamId),
      fetchStreamGovernance(streamId),
    ])
  } catch {
    return 'data-protection: existing Data Protection state could not be read, so no rules were created.'
  }
  if (!policy || !classification || !protection || !governance) {
    return 'data-protection: existing Data Protection state could not be read, so no rules were created.'
  }
  if (
    policy.rules.length > 0 ||
    classification.rules.length > 0 ||
    protection.rules.length > 0 ||
    governance.rules.length > 0
  ) {
    return 'data-protection: existing rules are already present and cannot be claimed by this draft. No rules were created or deleted.'
  }
  return null
}

async function persistEditDataProtection(
  streamId: number,
  state: WizardState,
  confirmed: WizardState | null,
): Promise<{ error: string | null; persisted: boolean }> {
  const currentKey = dataProtectionIntentKey(state)
  const confirmedKey = dataProtectionIntentKey(confirmed)
  if (confirmed != null && currentKey === confirmedKey) return { error: null, persisted: false }
  const clearing = confirmed != null && confirmed.dataProtection.intents.length > 0 && state.dataProtection.intents.length === 0
  if (clearing) {
    return {
      error: 'data-protection: clearing persisted Data Protection intents is not confirmed. Existing rules were not changed.',
      persisted: false,
    }
  }
  const replacing = confirmed != null && confirmed.dataProtection.intents.length > 0 && currentKey !== confirmedKey
  if (replacing) {
    return {
      error:
        'data-protection: changing Data Protection is not confirmed because existing rules cannot be replaced without durable wizard ownership. No rules were created or deleted.',
      persisted: false,
    }
  }
  if (state.dataProtection.intents.length === 0) return { error: null, persisted: false }
  const blocked = await existingDataProtectionBlocksCreate(streamId)
  if (blocked) return { error: blocked, persisted: false }
  const protectionResult = await persistWizardDataProtectionIntents(streamId, state)
  if (!protectionResult.saved) {
    return { error: protectionResult.errors.join(' · ') || 'data-protection: save failed.', persisted: false }
  }
  return { error: null, persisted: true }
}
