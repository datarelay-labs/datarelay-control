import {
  fetchStreamGovernance,
  putStreamGovernance,
  type GovernanceRouteOverride,
  type StreamGovernanceDocument,
} from '../../../api/gdcStreamGovernance'
import { inferWizardSensitivityClass } from './wizard-data-protection-fields'
import { normalizeWizardDetectedField } from './wizard-data-protection-fields'
import {
  isWizardOwnedPolicyRouteOverride,
  routeGovernanceConcernDisposition,
  routePolicyDeliveryBehavior,
} from './wizard-route-governance-bundle'
import {
  resolveWizardRouteDraftId,
  wizardDataProtectionIntentReady,
  type WizardDataProtectionState,
  type WizardRouteDraft,
  type WizardRouteClassificationOverride,
  type WizardRouteProtectionOverride,
  type WizardState,
} from './wizard-state'

export type RouteDraftKeyToIdMap = Map<string, number>

export type GovernancePersistResult = {
  saved: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Bind draft keys to route ids from an explicit map.
 * Missing ids are omitted so a failed earlier create cannot shift later bindings.
 */
export function buildRouteDraftKeyToIdMap(
  routeDrafts: readonly WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): RouteDraftKeyToIdMap {
  const map = new Map<string, number>()
  for (const draft of routeDrafts) {
    const routeId = routeIdsByDraftKey[draft.key]
    if (typeof routeId === 'number' && Number.isFinite(routeId) && routeId > 0) {
      map.set(draft.key, routeId)
    }
  }
  return map
}

function normalizeOverrideFieldPath(path: string): string {
  const normalized = normalizeWizardDetectedField(path)
  return normalized || path.trim()
}

export function isDuplicateRouteOverride(
  overrides: readonly WizardRouteProtectionOverride[],
  fieldPath: string,
  routeDraftKey: string,
  excludeKey?: string,
): boolean {
  const normalizedField = normalizeOverrideFieldPath(fieldPath)
  return overrides.some(
    (o) =>
      o.key !== excludeKey &&
      normalizeOverrideFieldPath(o.fieldPath) === normalizedField &&
      o.routeDraftKey === routeDraftKey,
  )
}

export function isDuplicateRouteClassificationOverride(
  overrides: readonly WizardRouteClassificationOverride[],
  routeDraftKey: string,
  excludeKey?: string,
): boolean {
  return overrides.some(
    (o) => o.key !== excludeKey && o.routeDraftKey === routeDraftKey,
  )
}

export function buildStreamGovernancePayload(
  dataProtection: WizardDataProtectionState,
  routeDraftKeyToId: RouteDraftKeyToIdMap,
): StreamGovernanceDocument {
  const validIntents = dataProtection.intents.filter(wizardDataProtectionIntentReady)

  const rules = validIntents.map((intent) => {
    const fieldPath = normalizeOverrideFieldPath(intent.detectedField)
    return {
      field_path: fieldPath,
      sensitivity_type: inferWizardSensitivityClass(fieldPath),
      default_protection_action: intent.protectionAction,
      default_delivery_behavior: intent.deliveryBehavior,
      enabled: true,
    }
  })

  const protectionOverrides = dataProtection.routeOverrides
    .filter((o) => o.enabled)
    .map((override) => {
      const routeId = routeDraftKeyToId.get(override.routeDraftKey)
      if (routeId == null) return null
      return {
        field_path: normalizeOverrideFieldPath(override.fieldPath),
        route_id: routeId,
        protection_action: override.protectionAction,
        delivery_behavior: override.deliveryBehavior,
        enabled: true,
      }
    })
    .filter((o): o is NonNullable<typeof o> => o != null)

  const classificationOverrides = dataProtection.routeClassificationOverrides
    .filter((o) => o.enabled && o.routeDraftKey)
    .map((override) => {
      const routeId = routeDraftKeyToId.get(override.routeDraftKey)
      if (routeId == null) return null
      return {
        route_id: routeId,
        classification_level: override.classificationLevel,
        enabled: true,
      }
    })
    .filter((o): o is NonNullable<typeof o> => o != null)

  const route_overrides = [...protectionOverrides, ...classificationOverrides]

  return {
    enabled: validIntents.length > 0 || route_overrides.length > 0,
    rules,
    route_overrides,
  }
}

export function governancePayloadHasContent(payload: StreamGovernanceDocument): boolean {
  return payload.rules.length > 0 || payload.route_overrides.length > 0
}

export function wizardPolicyRouteOverrides(
  routeDrafts: readonly WizardRouteDraft[],
  routeDraftKeyToId: RouteDraftKeyToIdMap,
): GovernanceRouteOverride[] {
  const overrides: GovernanceRouteOverride[] = []
  for (const draft of routeDrafts) {
    if (routeGovernanceConcernDisposition(draft, 'policy') !== 'replace') continue
    const routeId = routeDraftKeyToId.get(draft.key)
    const behavior = routePolicyDeliveryBehavior(draft)
    if (routeId == null || behavior == null) continue
    overrides.push({
      field_path: null,
      route_id: routeId,
      delivery_behavior: behavior,
      enabled: true,
    })
  }
  return overrides
}

function managedPolicyRouteIds(
  routeDrafts: readonly WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): Set<number> {
  const ids = new Set<number>()
  for (const draft of routeDrafts) {
    if (routeGovernanceConcernDisposition(draft, 'policy') === 'skip') continue
    const routeId = resolveWizardRouteDraftId(draft, routeIdsByDraftKey)
    if (routeId != null) ids.add(routeId)
  }
  return ids
}

function governanceRuleKey(rule: { field_path: string }): string {
  return normalizeOverrideFieldPath(rule.field_path)
}

/**
 * Field-level identity. Action and classification values are payload, not identity,
 * so an edit replaces the same route/field row instead of appending a second one.
 * Absent keys stay untouched: edit does not hydrate field-level governance, so an
 * omitted row means unchanged rather than cleared.
 */
function fieldLevelOverrideKey(override: GovernanceRouteOverride): string | null {
  if (isWizardOwnedPolicyRouteOverride(override)) return null
  const classification = (override.classification_level ?? '').trim()
  const field = (override.field_path ?? '').trim()
  if (classification && !field) return `classification:${override.route_id}`
  if (field) return `protection:${override.route_id}:${normalizeOverrideFieldPath(field)}`
  const protection = (override.protection_action ?? '').trim()
  const delivery = (override.delivery_behavior ?? '').trim()
  return `other:${override.route_id}:${protection}:${delivery}:${classification}`
}

function mergeByStableKey<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const incomingByKey = new Map(incoming.map((item) => [keyOf(item), item]))
  const seen = new Set<string>()
  const merged: T[] = []
  for (const item of current) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    const replacement = incomingByKey.get(key)
    if (replacement) {
      merged.push(replacement)
      incomingByKey.delete(key)
    } else {
      merged.push(item)
    }
  }
  for (const item of incoming) {
    const key = keyOf(item)
    if (!incomingByKey.has(key)) continue
    merged.push(item)
    incomingByKey.delete(key)
  }
  return merged
}

/**
 * Overlay Wizard field-level rules and overrides onto current governance by stable
 * key. Unrelated persisted rows stay. Wizard-owned Policy delivery overrides are
 * still replaced only for routes whose Policy concern is loaded or authored.
 */
export function mergeStreamGovernanceDocument(
  current: StreamGovernanceDocument | null,
  wizard: StreamGovernanceDocument,
  routeDrafts: readonly WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): StreamGovernanceDocument {
  const managed = managedPolicyRouteIds(routeDrafts, routeIdsByDraftKey)
  const policyOverrides = wizardPolicyRouteOverrides(
    routeDrafts,
    buildRouteDraftKeyToIdMap(routeDrafts, routeIdsByDraftKey),
  )
  const currentOverrides = current?.route_overrides ?? []
  const keptPolicy = currentOverrides.filter(
    (override) => isWizardOwnedPolicyRouteOverride(override) && !managed.has(override.route_id),
  )
  const currentField = currentOverrides.filter((override) => !isWizardOwnedPolicyRouteOverride(override))
  const wizardField = wizard.route_overrides.filter((override) => !isWizardOwnedPolicyRouteOverride(override))
  const fieldOverrides = mergeByStableKey(currentField, wizardField, (override) => {
    return fieldLevelOverrideKey(override) ?? `policy:${override.route_id}`
  })
  const rules = mergeByStableKey(current?.rules ?? [], wizard.rules, governanceRuleKey)
  const route_overrides = [...fieldOverrides, ...keptPolicy, ...policyOverrides]
  const enabled =
    wizard.enabled ||
    Boolean(current?.enabled) ||
    rules.length > 0 ||
    route_overrides.length > 0
  return { enabled, rules, route_overrides }
}

function policyReadBackErrors(
  readBack: StreamGovernanceDocument,
  routeDrafts: readonly WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): string[] {
  const errors: string[] = []
  for (const draft of routeDrafts) {
    const disposition = routeGovernanceConcernDisposition(draft, 'policy')
    if (disposition === 'skip') continue
    const routeId = resolveWizardRouteDraftId(draft, routeIdsByDraftKey)
    if (routeId == null) continue
    const actual = readBack.route_overrides.find(
      (override) =>
        override.route_id === routeId &&
        override.enabled !== false &&
        isWizardOwnedPolicyRouteOverride(override),
    )
    if (disposition === 'clear') {
      if (actual) {
        errors.push(
          `route ${routeId} policy: governance read-back still has delivery_behavior=${actual.delivery_behavior ?? 'unknown'}`,
        )
      }
      continue
    }
    const expected = routePolicyDeliveryBehavior(draft)
    if (expected == null || actual?.delivery_behavior !== expected) {
      errors.push(
        `route ${routeId} policy: governance read-back delivery_behavior=${actual?.delivery_behavior ?? 'missing'}, expected ${expected ?? 'missing'}`,
      )
    }
  }
  return errors
}

export async function persistWizardStreamGovernance(
  streamId: number,
  state: WizardState,
  routeIdsByDraftKey: Record<string, number>,
): Promise<GovernancePersistResult> {
  const routeDrafts = state.destinations.routeDrafts
  const routeDraftKeyToId = buildRouteDraftKeyToIdMap(routeDrafts, routeIdsByDraftKey)
  const wizardPayload = buildStreamGovernancePayload(state.dataProtection, routeDraftKeyToId)
  const policyTouchesDraft = routeDrafts.some(
    (draft) => routeGovernanceConcernDisposition(draft, 'policy') !== 'skip',
  )

  if (!governancePayloadHasContent(wizardPayload) && !policyTouchesDraft) {
    return { saved: true, errors: [], warnings: [] }
  }

  const warnings: string[] = []
  const skippedProtection = state.dataProtection.routeOverrides.filter(
    (o) => o.enabled && !routeDraftKeyToId.has(o.routeDraftKey),
  )
  const skippedClassification = state.dataProtection.routeClassificationOverrides.filter(
    (o) => o.enabled && !routeDraftKeyToId.has(o.routeDraftKey),
  )
  const skippedPolicy = routeDrafts.filter((draft) => {
    if (routeGovernanceConcernDisposition(draft, 'policy') !== 'replace') return false
    return resolveWizardRouteDraftId(draft, routeIdsByDraftKey) == null
  })
  const skippedCount = skippedProtection.length + skippedClassification.length + skippedPolicy.length
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} route override(s) skipped — route was not created.`)
  }

  let current: Awaited<ReturnType<typeof fetchStreamGovernance>>
  try {
    current = await fetchStreamGovernance(streamId)
  } catch (err) {
    return {
      saved: false,
      errors: [`governance: could not read current governance; refusing to replace (${err instanceof Error ? err.message : String(err)})`],
      warnings,
    }
  }
  if (current == null) {
    return {
      saved: false,
      errors: ['governance: could not read current governance; refusing to replace'],
      warnings,
    }
  }

  const payload = mergeStreamGovernanceDocument(current, wizardPayload, routeDrafts, routeIdsByDraftKey)
  const policyOverrides = wizardPolicyRouteOverrides(routeDrafts, routeDraftKeyToId)
  const managedPolicyIds = new Set(
    routeDrafts.flatMap((draft) => {
      if (routeGovernanceConcernDisposition(draft, 'policy') === 'skip') return []
      const routeId = resolveWizardRouteDraftId(draft, routeIdsByDraftKey)
      return routeId == null ? [] : [routeId]
    }),
  )
  const removesExistingPolicy = (current.route_overrides ?? []).some(
    (override) => isWizardOwnedPolicyRouteOverride(override) && managedPolicyIds.has(override.route_id),
  )
  if (!governancePayloadHasContent(wizardPayload) && policyOverrides.length === 0 && !removesExistingPolicy) {
    return { saved: true, errors: [], warnings }
  }

  try {
    await putStreamGovernance(streamId, payload)
  } catch (err) {
    return {
      saved: false,
      errors: [`governance: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    }
  }

  let readBack: Awaited<ReturnType<typeof fetchStreamGovernance>>
  try {
    readBack = await fetchStreamGovernance(streamId)
  } catch (err) {
    return {
      saved: false,
      errors: [`governance: read-back failed (${err instanceof Error ? err.message : String(err)})`],
      warnings,
    }
  }
  if (readBack == null) {
    return {
      saved: false,
      errors: ['governance: read-back returned no result'],
      warnings,
    }
  }
  const readBackErrors = policyReadBackErrors(readBack, routeDrafts, routeIdsByDraftKey)
  if (readBackErrors.length > 0) {
    return { saved: false, errors: readBackErrors, warnings }
  }
  return { saved: true, errors: [], warnings }
}
