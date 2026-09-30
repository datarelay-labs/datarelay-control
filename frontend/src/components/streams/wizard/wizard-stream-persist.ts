import { fetchStreamClassificationRules } from '../../../api/gdcClassification'
import { fetchStreamPolicyRules } from '../../../api/gdcPolicy'
import { fetchStreamProtectionRules } from '../../../api/gdcProtection'
import { createRoute, deleteRoute, updateRoute, updateRouteWithFreshToken } from '../../../api/gdcRoutes'
import { fetchStreamGovernance } from '../../../api/gdcStreamGovernance'
import {
  fetchRouteTransformEffective,
  saveRouteEnrichmentUiConfig,
  saveRouteMappingUiConfig,
} from '../../../api/gdcRouteTransform'
import { saveStreamMappingUiConfigStrict } from '../../../api/gdcRuntimeUi'
import { fetchStreamById, updateStream } from '../../../api/gdcStreams'
import {
  applyExplicitCheckpointClear,
  applyExplicitEventPathClear,
  buildAdvancedStreamConfigJsonPatch,
  mergeStreamConfigJson,
} from './wizard-stream-config-sync'
import {
  buildRouteCreatePayloads,
  buildRouteTransformPersistPlans,
  buildStreamConfigPayload,
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
import { persistWizardSchemaDriftPolicy } from './wizard-schema-drift-policy-persist'
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
}

export type SyncRoutesResult = {
  errors: string[]
  /** Server route id keyed by draft key (existing `route-N` or newly created). */
  routeIdsByDraftKey: Record<string, number>
  routeUpdatedAtByDraftKey: Record<string, string>
}

function routeKeyToId(key: string): number | null {
  const match = /^route-(\d+)$/.exec(key)
  if (!match) return null
  const id = Number(match[1])
  return Number.isFinite(id) ? id : null
}

export async function syncRoutes(streamId: number, state: WizardState): Promise<SyncRoutesResult> {
  const errors: string[] = []
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
        if (updated.updated_at) routeUpdatedAtByDraftKey[draft.key] = updated.updated_at
      } else {
        const created = await createRoute(payload)
        routeIdsByDraftKey[draft.key] = created.id
      }
    } catch (err) {
      errors.push(`route ${draft.destinationId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const protectedIds = new Set<number>()
  for (const draft of state.destinations.routeDrafts) {
    const existingId = routeKeyToId(draft.key)
    if (existingId != null) protectedIds.add(existingId)
  }
  const keptIds = new Set(Object.values(routeIdsByDraftKey))
  for (const priorId of state.outcome?.routeIds ?? []) {
    if (keptIds.has(priorId) || protectedIds.has(priorId)) continue
    try {
      await updateRouteWithFreshToken(priorId, {
        stream_id: streamId,
        enabled: false,
        status: 'DISABLED',
      })
    } catch (err) {
      errors.push(`disable route ${priorId}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    try {
      await deleteRoute(priorId)
    } catch (err) {
      errors.push(`delete route ${priorId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { errors, routeIdsByDraftKey, routeUpdatedAtByDraftKey }
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
    }
  }

  const confirmed = options?.confirmedState ?? null
  let persistedConfigJson: Record<string, unknown> | null = null
  let streamUpdatedAt: string | null = null
  try {
    const existing = await fetchStreamById(streamId)
    const token = existing?.updated_at
    if (typeof token !== 'string' || !token) {
      errors.push('stream: concurrency token is missing, so this draft was not written.')
    } else {
      const existingConfig =
        existing?.config_json && typeof existing.config_json === 'object' && !Array.isArray(existing.config_json)
          ? (existing.config_json as Record<string, unknown>)
          : {}
      const sourcePayload =
        state.connector.sourceType === 'S3_OBJECT_POLLING' ? payload.config_json : buildStreamConfigPayload(state)
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
      const config_json = eventPaths.config
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
      persistedConfigJson = config_json
      streamUpdatedAt = updated.updated_at ?? token
    }
  } catch (err) {
    errors.push(`stream: ${err instanceof Error ? err.message : String(err)}`)
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
    } catch (err) {
      errors.push(`mapping-ui: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const synced = await syncRoutes(streamId, state)
  errors.push(...synced.errors)
  const routeIdsByDraftKey: Record<string, number> = { ...synced.routeIdsByDraftKey }
  for (const draft of state.destinations.routeDrafts) {
    if (routeIdsByDraftKey[draft.key]) continue
    const fromKey = routeKeyToId(draft.key)
    if (fromKey != null) routeIdsByDraftKey[draft.key] = fromKey
  }
  errors.push(
    ...(await persistWizardRouteTransformOverrides(state.destinations.routeDrafts, routeIdsByDraftKey)),
  )
  errors.push(
    ...(await verifyWizardRouteTransformEffective(state.destinations.routeDrafts, routeIdsByDraftKey)),
  )
  errors.push(
    ...(await persistWizardRouteGovernanceBundles(state.destinations.routeDrafts, routeIdsByDraftKey)),
  )

  const protection = await persistEditDataProtection(streamId, state, confirmed)
  if (protection.error) errors.push(protection.error)

  try {
    const governanceResult = await persistWizardStreamGovernance(streamId, state, routeIdsByDraftKey)
    if (!governanceResult.saved) errors.push(...governanceResult.errors)
  } catch (err) {
    errors.push(`governance: ${err instanceof Error ? err.message : String(err)}`)
  }
  errors.push(
    ...(await verifyWizardRouteGovernanceEffective(
      state.destinations.routeDrafts,
      routeIdsByDraftKey,
      state.dataProtection,
    )),
  )

  if (persistedConfigJson) {
    try {
      const driftResult = await persistWizardSchemaDriftPolicy(streamId, state.dataProtection, {
        existingConfigJson: persistedConfigJson,
      })
      if (!driftResult.saved) errors.push(...driftResult.errors)
    } catch (err) {
      errors.push(`schema-drift-policy: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    routeIdsByDraftKey,
    routeUpdatedAtByDraftKey: synced.routeUpdatedAtByDraftKey,
    streamUpdatedAt,
    dataProtectionPersisted: protection.persisted,
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
