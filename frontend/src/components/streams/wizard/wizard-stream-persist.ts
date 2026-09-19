import { createRoute, deleteRoute, updateRouteWithFreshToken } from '../../../api/gdcRoutes'
import { saveRouteEnrichmentUiConfig, saveRouteMappingUiConfig } from '../../../api/gdcRouteTransform'
import { saveStreamMappingUiConfigStrict } from '../../../api/gdcRuntimeUi'
import { fetchStreamById, updateStream } from '../../../api/gdcStreams'
import {
  buildAdvancedStreamConfigJsonPatch,
  mergeStreamConfigJson,
} from './wizard-stream-config-sync'
import {
  buildRouteCreatePayloads,
  buildRouteTransformPersistPlans,
  buildStreamCreatePayload,
  buildWizardFieldMappingsPayload,
  enrichmentDictFromRows,
  wizardFieldMappingsReady,
  type WizardRouteDraft,
  type WizardState,
} from './wizard-state'
import { persistWizardDataProtectionIntents } from './wizard-data-protection-persist'
import { persistWizardSchemaDriftPolicy } from './wizard-schema-drift-policy-persist'
import { persistWizardStreamGovernance } from './wizard-governance-persist'

export type WizardStreamPersistResult = {
  ok: boolean
  errors: string[]
}

export type SyncRoutesResult = {
  errors: string[]
  /** Server route id keyed by draft key (existing `route-N` or newly created). */
  routeIdsByDraftKey: Record<string, number>
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
  const payloads = buildRouteCreatePayloads(streamId, state.destinations)

  for (const draft of state.destinations.routeDrafts) {
    const routeId = routeKeyToId(draft.key)
    const payload = payloads.find((p) => p.destination_id === draft.destinationId)
    if (!payload) continue

    try {
      if (routeId != null) {
        await updateRouteWithFreshToken(routeId, {
          stream_id: streamId,
          enabled: payload.enabled,
          failure_policy: payload.failure_policy,
          status: payload.status,
          formatter_config_json: payload.formatter_config_json,
          rate_limit_json: payload.rate_limit_json,
        })
        routeIdsByDraftKey[draft.key] = routeId
      } else {
        const created = await createRoute(payload)
        routeIdsByDraftKey[draft.key] = created.id
      }
    } catch (err) {
      errors.push(`route ${draft.destinationId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const keptIds = new Set(Object.values(routeIdsByDraftKey))
  for (const priorId of state.outcome?.routeIds ?? []) {
    if (keptIds.has(priorId)) continue
    try {
      await deleteRoute(priorId)
    } catch (err) {
      errors.push(`delete route ${priorId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { errors, routeIdsByDraftKey }
}

export async function persistWizardRouteTransformOverrides(
  drafts: WizardRouteDraft[],
  routeIdsInDraftOrder: number[],
): Promise<string[]> {
  const errors: string[] = []
  for (const plan of buildRouteTransformPersistPlans(drafts, routeIdsInDraftOrder)) {
    const hasMapping = Object.keys(plan.fieldMappings).length > 0
    const hasEnrichment = Object.keys(plan.enrichment).length > 0
    if (hasMapping) {
      try {
        await saveRouteMappingUiConfig(plan.routeId, {
          inherit: plan.inherit,
          mapping: { field_mappings: plan.fieldMappings },
        })
      } catch (err) {
        errors.push(
          `route ${plan.routeId} mapping: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (hasEnrichment) {
      try {
        await saveRouteEnrichmentUiConfig(plan.routeId, {
          inherit: plan.inherit,
          enrichment: {
            enabled: true,
            enrichment: plan.enrichment,
            override_policy: 'KEEP_EXISTING',
          },
        })
      } catch (err) {
        errors.push(
          `route ${plan.routeId} enrichment: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }
  return errors
}

export async function persistWizardStreamEdits(streamId: number, state: WizardState): Promise<WizardStreamPersistResult> {
  const errors: string[] = []
  const payload = buildStreamCreatePayload(state)
  if (payload == null) {
    return { ok: false, errors: ['Connector and source are required before saving.'] }
  }

  try {
    const existing = await fetchStreamById(streamId)
    const existingConfig =
      existing?.config_json && typeof existing.config_json === 'object' && !Array.isArray(existing.config_json)
        ? (existing.config_json as Record<string, unknown>)
        : {}
    const config_json = mergeStreamConfigJson(
      existingConfig,
      payload.config_json,
      buildAdvancedStreamConfigJsonPatch(state.stream),
    )
    await updateStream(streamId, {
      name: payload.name,
      polling_interval: payload.polling_interval,
      stream_type: payload.stream_type,
      config_json,
      rate_limit_json: payload.rate_limit_json,
    })
  } catch (err) {
    errors.push(`stream: ${err instanceof Error ? err.message : String(err)}`)
  }

  const fieldMappings = buildWizardFieldMappingsPayload(state)
  const enrichmentDict = enrichmentDictFromRows(state.enrichment)
  const hasMapping = wizardFieldMappingsReady(state)
  const hasEnrichment = Object.keys(enrichmentDict).length > 0
  const hasEventPaths =
    state.stream.useWholeResponseAsEvent ||
    state.stream.eventArrayPath.trim().length > 0 ||
    state.stream.eventRootPath.trim().length > 0

  if (hasMapping || hasEnrichment || hasEventPaths) {
    try {
      await saveStreamMappingUiConfigStrict(streamId, {
        mapping:
          hasMapping || hasEventPaths
            ? {
                field_mappings: hasMapping ? fieldMappings : {},
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
        enrichment: hasEnrichment
          ? {
              enabled: true,
              enrichment: enrichmentDict,
              override_policy: 'KEEP_EXISTING',
            }
          : null,
      })
    } catch (err) {
      errors.push(`mapping-ui: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const synced = await syncRoutes(streamId, state)
  errors.push(...synced.errors)
  const orderedRouteIds = state.destinations.routeDrafts.map(
    (draft) => synced.routeIdsByDraftKey[draft.key] ?? routeKeyToId(draft.key) ?? 0,
  )
  errors.push(
    ...(await persistWizardRouteTransformOverrides(state.destinations.routeDrafts, orderedRouteIds)),
  )

  if (state.dataProtection.intents.length > 0) {
    const protectionResult = await persistWizardDataProtectionIntents(streamId, state)
    if (!protectionResult.saved) errors.push(...protectionResult.errors)
  }

  try {
    const routeIds = state.destinations.routeDrafts
      .map((draft) => synced.routeIdsByDraftKey[draft.key] ?? routeKeyToId(draft.key))
      .filter((id): id is number => id != null)
    const governanceResult = await persistWizardStreamGovernance(streamId, state, routeIds)
    if (!governanceResult.saved) errors.push(...governanceResult.errors)
  } catch (err) {
    errors.push(`governance: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const driftResult = await persistWizardSchemaDriftPolicy(streamId, state.dataProtection, {
      existingConfigJson: payload.config_json,
    })
    if (!driftResult.saved) errors.push(...driftResult.errors)
  } catch (err) {
    errors.push(`schema-drift-policy: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: errors.length === 0, errors }
}
