import type { ClassificationLevel } from '../../../api/gdcClassification'
import { wizardProtectionActionToMode, type ProtectionMode } from '../../../api/gdcProtection'
import {
  fetchRouteClassificationEffective,
  fetchRouteClassificationRules,
  replaceRouteClassificationRules,
  type RouteClassificationRule,
} from '../../../api/gdcRouteClassification'
import {
  fetchRoutePolicyEffective,
  fetchRoutePolicyRules,
} from '../../../api/gdcRoutePolicy'
import {
  fetchRouteProtectionEffective,
  fetchRouteProtectionRules,
  replaceRouteProtectionRules,
  type RouteProtectionRule,
} from '../../../api/gdcRouteProtection'
import {
  fetchStreamGovernance,
  type GovernanceRouteOverride,
} from '../../../api/gdcStreamGovernance'
import { inferWizardSensitivityClass, normalizeWizardDetectedField } from './wizard-data-protection-fields'
import {
  buildDataProtectionPersistPreview,
  protectionActionNeedsFieldRule,
} from './wizard-data-protection-persist'
import {
  resolveWizardRouteDraftId,
  wizardDataProtectionIntentReady,
  type RouteProcessingStatus,
  type WizardDataProtectionIntent,
  type WizardDataProtectionState,
  type WizardDeliveryBehavior,
  type WizardRouteDraft,
  type WizardRouteGovernanceConcernLoad,
  type WizardRouteGovernanceLoad,
  type WizardRouteProtectionOverrideState,
  type WizardSensitivityClass,
} from './wizard-state'

export type RouteGovernanceConcern = 'protection' | 'classification' | 'policy'

type ProtectionRuleBody = {
  field_path: string
  sensitivity_class: string
  protection_mode: ProtectionMode
  enabled: boolean
}

type ClassificationRuleBody = {
  name: string
  enabled: boolean
  condition_json: { sensitivity_class: WizardSensitivityClass }
  classification_level: ClassificationLevel
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function routeProtectionIntents(draft: WizardRouteDraft): WizardDataProtectionIntent[] {
  return draft.overrides?.protection?.intents ?? []
}

export function routeProtectionOverridePersistPayload(draft: WizardRouteDraft): ProtectionRuleBody[] | null {
  if (draft.inherit.protection !== false) return null
  const rules: ProtectionRuleBody[] = []
  const seen = new Set<string>()
  for (const intent of routeProtectionIntents(draft)) {
    if (!wizardDataProtectionIntentReady(intent)) continue
    if (!protectionActionNeedsFieldRule(intent.protectionAction)) continue
    if (intent.protectionAction === 'audit') continue
    const fieldPath = normalizeWizardDetectedField(intent.detectedField)
    if (seen.has(fieldPath)) continue
    seen.add(fieldPath)
    rules.push({
      field_path: fieldPath,
      sensitivity_class: inferWizardSensitivityClass(fieldPath),
      protection_mode: wizardProtectionActionToMode(intent.protectionAction),
      enabled: true,
    })
  }
  return rules.length > 0 ? rules : null
}

function classificationRuleName(sensitivityClass: WizardSensitivityClass): string {
  switch (sensitivityClass) {
    case 'secret':
      return 'Wizard route: secret classification'
    case 'security_metadata':
      return 'Wizard route: security metadata classification'
    default:
      return 'Wizard route: personal data classification'
  }
}

export function routeClassificationOverridePersistPayload(
  draft: WizardRouteDraft,
): ClassificationRuleBody[] | null {
  if (draft.inherit.classification !== false) return null
  const preview = buildDataProtectionPersistPreview({
    intents: routeProtectionIntents(draft),
    routeOverrides: [],
    routeClassificationOverrides: [],
    unknownNormalFieldPolicy: 'pass_through',
    unknownSensitiveFieldPolicy: 'auto_protect',
  })
  const rules = preview.aggregated
    .filter((group): group is typeof group & { classificationLevel: ClassificationLevel } =>
      group.classificationLevel != null,
    )
    .map((group) => ({
      name: classificationRuleName(group.sensitivityClass),
      enabled: true,
      condition_json: { sensitivity_class: group.sensitivityClass },
      classification_level: group.classificationLevel,
    }))
  return rules.length > 0 ? rules : null
}

const POLICY_DELIVERY_BEHAVIORS = new Set<WizardDeliveryBehavior>(['continue', 'quarantine', 'block'])

export function routePolicyDeliveryBehavior(draft: WizardRouteDraft): WizardDeliveryBehavior | null {
  if (draft.inherit?.policy !== false) return null
  const behavior = draft.overrides?.policy?.deliveryBehavior
  if (behavior == null || !POLICY_DELIVERY_BEHAVIORS.has(behavior)) return null
  return behavior
}

/** Field-less canonical route override owned by the Wizard Policy full-bundle. */
export function isWizardOwnedPolicyRouteOverride(override: {
  field_path?: string | null
  protection_action?: string | null
  classification_level?: string | null
  delivery_behavior?: string | null
}): boolean {
  const field = (override.field_path ?? '').trim()
  const protection = (override.protection_action ?? '').trim()
  const classification = (override.classification_level ?? '').trim()
  const delivery = (override.delivery_behavior ?? '').trim()
  return field.length === 0 && protection.length === 0 && classification.length === 0 && delivery.length > 0
}

export type RouteGovernancePersistDisposition = 'skip' | 'clear' | 'replace'

function concernLoad(
  draft: WizardRouteDraft,
  concern: RouteGovernanceConcern,
): WizardRouteGovernanceConcernLoad | undefined {
  return draft.governanceLoad?.[concern]
}

/** Unloaded, unreadable, and passthrough concerns stay unchanged. */
export function routeGovernanceConcernDisposition(
  draft: WizardRouteDraft,
  concern: RouteGovernanceConcern,
): RouteGovernancePersistDisposition {
  const load = concernLoad(draft, concern)
  if (load === 'unloaded' || load === 'unavailable' || load === 'passthrough') return 'skip'
  if (concern === 'policy') {
    if (draft.inherit?.policy !== false) return 'clear'
    return routePolicyDeliveryBehavior(draft) == null ? 'skip' : 'replace'
  }
  const inherited =
    concern === 'protection' ? draft.inherit?.protection !== false : draft.inherit?.classification !== false
  if (inherited) return 'clear'
  const payload =
    concern === 'protection'
      ? routeProtectionOverridePersistPayload(draft)
      : routeClassificationOverridePersistPayload(draft)
  return payload == null ? 'skip' : 'replace'
}

export function hasPersistableRouteProtectionOverride(draft: WizardRouteDraft): boolean {
  return routeProtectionOverridePersistPayload(draft) != null
}

export function hasPersistableRouteClassificationOverride(draft: WizardRouteDraft): boolean {
  return routeClassificationOverridePersistPayload(draft) != null
}

export function hasPersistableRoutePolicyOverride(draft: WizardRouteDraft): boolean {
  return routePolicyDeliveryBehavior(draft) != null
}

function hasProtectionGovernanceOverride(
  dataProtection: WizardDataProtectionState,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeOverrides.some((override) => override.enabled && override.routeDraftKey === routeDraftKey)
}

function hasClassificationGovernanceOverride(
  dataProtection: WizardDataProtectionState,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeClassificationOverrides.some(
    (override) => override.enabled && override.routeDraftKey === routeDraftKey,
  )
}

function hasPolicyGovernanceOverride(
  dataProtection: WizardDataProtectionState,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeOverrides.some(
    (override) =>
      override.enabled &&
      override.routeDraftKey === routeDraftKey &&
      (override.deliveryBehavior === 'continue' ||
        override.deliveryBehavior === 'quarantine' ||
        override.deliveryBehavior === 'block'),
  )
}

export function hasGovernanceOverrideForConcern(
  concern: RouteGovernanceConcern,
  draft: WizardRouteDraft,
  dataProtection: WizardDataProtectionState,
): boolean {
  if (concern === 'protection') return hasProtectionGovernanceOverride(dataProtection, draft.key)
  if (concern === 'classification') return hasClassificationGovernanceOverride(dataProtection, draft.key)
  return hasPolicyGovernanceOverride(dataProtection, draft.key)
}

/**
 * Expected Effective processing_status after a persistable bundle save.
 * Governance field overrides on the same route make the bundle Mixed.
 * Returns null when the concern is intent-only and must not be claimed.
 */
export function expectedRouteGovernanceProcessingStatus(
  concern: RouteGovernanceConcern,
  draft: WizardRouteDraft,
  dataProtection: WizardDataProtectionState,
): RouteProcessingStatus | 'governance_retained' | null {
  if (routeGovernanceConcernDisposition(draft, concern) === 'skip') return null
  const payload =
    concern === 'protection'
      ? routeProtectionOverridePersistPayload(draft)
      : concern === 'classification'
        ? routeClassificationOverridePersistPayload(draft)
        : routePolicyDeliveryBehavior(draft)
  const inherited =
    concern === 'protection'
      ? draft.inherit.protection !== false
      : concern === 'classification'
        ? draft.inherit.classification !== false
        : draft.inherit.policy !== false

  if (!inherited && payload == null) return null
  const governance = hasGovernanceOverrideForConcern(concern, draft, dataProtection)
  if (inherited) return governance ? 'governance_retained' : 'Inherited'
  if (concern === 'policy') return 'Overridden'
  return governance ? 'Mixed' : 'Overridden'
}

function protectionReadBackMatches(desired: ProtectionRuleBody[], rules: RouteProtectionRule[]): boolean {
  if (rules.length !== desired.length) return false
  const byPath = new Map(rules.map((rule) => [rule.field_path, rule]))
  return desired.every((rule) => {
    const actual = byPath.get(rule.field_path)
    return (
      actual != null &&
      actual.enabled !== false &&
      actual.protection_mode === rule.protection_mode &&
      actual.sensitivity_class === rule.sensitivity_class
    )
  })
}

function classificationReadBackMatches(
  desired: ClassificationRuleBody[],
  rules: RouteClassificationRule[],
): boolean {
  if (rules.length !== desired.length) return false
  const byClass = new Map(
    rules.map((rule) => [String(rule.condition_json?.sensitivity_class ?? ''), rule]),
  )
  return desired.every((rule) => {
    const actual = byClass.get(rule.condition_json.sensitivity_class)
    return (
      actual != null &&
      actual.enabled !== false &&
      actual.classification_level === rule.classification_level
    )
  })
}

async function replaceProtectionRules(routeId: number, desired: ProtectionRuleBody[]): Promise<string | null> {
  try {
    const replaced = await replaceRouteProtectionRules(routeId, desired)
    if (replaced == null || !protectionReadBackMatches(desired, replaced.rules)) {
      return `route ${routeId} protection: rules read-back did not match the saved override`
    }
  } catch (err) {
    return `route ${routeId} protection: ${errorText(err)}`
  }
  let readBack
  try {
    readBack = await fetchRouteProtectionRules(routeId)
  } catch (err) {
    return `route ${routeId} protection rules: ${errorText(err)}`
  }
  if (readBack == null) return `route ${routeId} protection: rules read-back returned no result`
  if (!protectionReadBackMatches(desired, readBack.rules)) {
    return `route ${routeId} protection: rules read-back did not match the saved override`
  }
  return null
}

async function replaceClassificationRules(
  routeId: number,
  desired: ClassificationRuleBody[],
): Promise<string | null> {
  try {
    const replaced = await replaceRouteClassificationRules(routeId, desired)
    if (replaced == null || !classificationReadBackMatches(desired, replaced.rules)) {
      return `route ${routeId} classification: rules read-back did not match the saved override`
    }
  } catch (err) {
    return `route ${routeId} classification: ${errorText(err)}`
  }
  let readBack
  try {
    readBack = await fetchRouteClassificationRules(routeId)
  } catch (err) {
    return `route ${routeId} classification rules: ${errorText(err)}`
  }
  if (readBack == null) return `route ${routeId} classification: rules read-back returned no result`
  if (!classificationReadBackMatches(desired, readBack.rules)) {
    return `route ${routeId} classification: rules read-back did not match the saved override`
  }
  return null
}

/**
 * Persist or clear route Protection and Classification bundles.
 * Policy full-bundle delivery behavior is persisted through Stream Governance.
 * Draft keys bind to route ids; a missing id does not shift later drafts.
 * Unloaded, unreadable, and passthrough concerns are left unchanged.
 * Empty inherit-off overrides are skipped so they are not stored as route rules.
 */
export async function persistWizardRouteGovernanceBundles(
  drafts: WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
): Promise<string[]> {
  const errors: string[] = []
  for (const draft of drafts) {
    const routeId = resolveWizardRouteDraftId(draft, routeIdsByDraftKey)
    if (routeId == null) continue

    const protectionDisposition = routeGovernanceConcernDisposition(draft, 'protection')
    if (protectionDisposition !== 'skip') {
      const protection = routeProtectionOverridePersistPayload(draft)
      const message = await replaceProtectionRules(routeId, protection ?? [])
      if (message) errors.push(message)
    }

    const classificationDisposition = routeGovernanceConcernDisposition(draft, 'classification')
    if (classificationDisposition !== 'skip') {
      const classification = routeClassificationOverridePersistPayload(draft)
      const message = await replaceClassificationRules(routeId, classification ?? [])
      if (message) errors.push(message)
    }
  }
  return errors
}

function statusMatches(
  actual: RouteProcessingStatus,
  expected: RouteProcessingStatus | 'governance_retained',
): boolean {
  if (expected === 'governance_retained') return actual === 'Mixed' || actual === 'Overridden'
  return actual === expected
}

function expectedLabel(expected: RouteProcessingStatus | 'governance_retained'): string {
  if (expected === 'governance_retained') return 'Mixed or Overridden'
  return expected
}

async function verifyConcernEffective(
  concern: RouteGovernanceConcern,
  routeId: number,
  expected: RouteProcessingStatus | 'governance_retained',
): Promise<string | null> {
  let effective: { processing_status: RouteProcessingStatus } | null
  try {
    if (concern === 'protection') effective = await fetchRouteProtectionEffective(routeId)
    else if (concern === 'classification') effective = await fetchRouteClassificationEffective(routeId)
    else effective = await fetchRoutePolicyEffective(routeId)
  } catch (err) {
    return `route ${routeId} ${concern} effective: ${errorText(err)}`
  }
  if (effective == null) {
    return `route ${routeId} ${concern}: Effective API returned no result (expected ${expectedLabel(expected)})`
  }
  if (!statusMatches(effective.processing_status, expected)) {
    return `route ${routeId} ${concern}: expected ${expectedLabel(expected)} after save, Effective API returned ${effective.processing_status}`
  }
  return null
}

/**
 * Read Effective status after governance field overrides are saved.
 * Intent-only bundles are not claimed. Inherited concerns must read Inherited
 * unless a field-level governance override still applies.
 */
async function adjustPolicyExpectedStatus(
  routeId: number,
  expected: RouteProcessingStatus | 'governance_retained',
): Promise<{ expected: RouteProcessingStatus | 'governance_retained' } | { error: string }> {
  let rules
  try {
    rules = await fetchRoutePolicyRules(routeId)
  } catch (err) {
    return { error: `route ${routeId} policy rules: ${errorText(err)}` }
  }
  if (rules == null) {
    return { error: `route ${routeId} policy: rules read-back returned no result` }
  }
  const hasRouteRules = rules.rules.some((rule) => rule.enabled !== false)
  if (expected === 'Overridden' && hasRouteRules) return { expected: 'Mixed' }
  if (expected === 'Inherited' && hasRouteRules) return { expected: 'Overridden' }
  return { expected }
}

export async function verifyWizardRouteGovernanceEffective(
  drafts: WizardRouteDraft[],
  routeIdsByDraftKey: Record<string, number>,
  dataProtection: WizardDataProtectionState,
): Promise<string[]> {
  const errors: string[] = []
  for (const draft of drafts) {
    const routeId = resolveWizardRouteDraftId(draft, routeIdsByDraftKey)
    if (routeId == null) continue
    for (const concern of ['protection', 'classification', 'policy'] as const) {
      let expected = expectedRouteGovernanceProcessingStatus(concern, draft, dataProtection)
      if (expected == null) continue
      if (concern === 'policy') {
        const adjusted = await adjustPolicyExpectedStatus(routeId, expected)
        if ('error' in adjusted) {
          errors.push(adjusted.error)
          continue
        }
        expected = adjusted.expected
      }
      const message = await verifyConcernEffective(concern, routeId, expected)
      if (message) errors.push(message)
    }
  }
  return errors
}

const PROTECTION_MODE_TO_ACTION = {
  partial_mask: 'mask_partial',
  full_mask: 'mask_full',
  tokenization: 'tokenize',
  hash: 'hash',
  drop_field: 'drop_field',
} as const

function protectionRulesReconstruct(
  rules: RouteProtectionRule[],
): { kind: 'inherited' } | { kind: 'hydrated'; protection: WizardRouteProtectionOverrideState } | { kind: 'passthrough' } {
  if (rules.length === 0) return { kind: 'inherited' }
  const intents: WizardRouteProtectionOverrideState['intents'] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (rule.enabled === false || rule.source_finding_id != null) return { kind: 'passthrough' }
    const action = PROTECTION_MODE_TO_ACTION[rule.protection_mode]
    if (action == null) return { kind: 'passthrough' }
    const fieldPath = normalizeWizardDetectedField(rule.field_path)
    if (!fieldPath || seen.has(fieldPath)) return { kind: 'passthrough' }
    if (rule.sensitivity_class !== inferWizardSensitivityClass(fieldPath)) return { kind: 'passthrough' }
    seen.add(fieldPath)
    intents.push({
      key: `hydrated-protection-${intents.length + 1}`,
      detectedField: fieldPath,
      protectionAction: action,
      deliveryBehavior: 'continue',
    })
  }
  return {
    kind: 'hydrated',
    protection: {
      intents,
      unknownNormalFieldPolicy: 'pass_through',
      unknownSensitiveFieldPolicy: 'auto_protect',
    },
  }
}

function classificationRulesMatchPayload(
  desired: ClassificationRuleBody[],
  rules: RouteClassificationRule[],
): boolean {
  if (rules.length !== desired.length) return false
  return desired.every((rule) =>
    rules.some(
      (actual) =>
        actual.enabled !== false &&
        actual.name === rule.name &&
        actual.classification_level === rule.classification_level &&
        String(actual.condition_json?.sensitivity_class ?? '') === rule.condition_json.sensitivity_class,
    ),
  )
}

function classificationRulesReconstruct(
  draft: WizardRouteDraft,
  rules: RouteClassificationRule[],
): 'inherited' | 'hydrated' | 'passthrough' {
  if (rules.length === 0) return 'inherited'
  if (draft.inherit.protection !== false || draft.overrides?.protection == null) return 'passthrough'
  const candidate: WizardRouteDraft = {
    ...draft,
    inherit: { ...draft.inherit, classification: false },
  }
  const desired = routeClassificationOverridePersistPayload(candidate)
  if (desired == null || !classificationRulesMatchPayload(desired, rules)) return 'passthrough'
  return 'hydrated'
}

function policyOverrideReconstruct(
  overrides: GovernanceRouteOverride[],
  routeId: number,
): { kind: 'inherited' } | { kind: 'hydrated'; deliveryBehavior: WizardDeliveryBehavior } | { kind: 'passthrough' } {
  const owned = overrides.filter(
    (override) => override.route_id === routeId && override.enabled !== false && isWizardOwnedPolicyRouteOverride(override),
  )
  if (owned.length === 0) return { kind: 'inherited' }
  if (owned.length !== 1) return { kind: 'passthrough' }
  const behavior = owned[0].delivery_behavior
  if (behavior !== 'continue' && behavior !== 'quarantine' && behavior !== 'block') return { kind: 'passthrough' }
  return { kind: 'hydrated', deliveryBehavior: behavior }
}

export type RouteGovernanceHydrationInput = {
  routeId: number
  protectionReadOk: boolean
  protectionRules: RouteProtectionRule[]
  classificationReadOk: boolean
  classificationRules: RouteClassificationRule[]
  policyReadOk: boolean
  policyOverrides: GovernanceRouteOverride[]
}

/** Apply a successful or failed governance read onto one route draft. */
export function applyRouteGovernanceHydration(
  draft: WizardRouteDraft,
  input: RouteGovernanceHydrationInput,
): WizardRouteDraft {
  const inherit = { ...draft.inherit }
  const overrides = draft.overrides ? { ...draft.overrides } : {}
  const load: WizardRouteGovernanceLoad = {
    protection: 'unavailable',
    classification: 'unavailable',
    policy: 'unavailable',
  }

  if (input.protectionReadOk) {
    const interpreted = protectionRulesReconstruct(input.protectionRules)
    if (interpreted.kind === 'inherited') {
      load.protection = 'inherited'
      inherit.protection = true
      delete overrides.protection
    } else if (interpreted.kind === 'hydrated') {
      load.protection = 'hydrated'
      inherit.protection = false
      overrides.protection = interpreted.protection
    } else {
      load.protection = 'passthrough'
    }
  }

  const withProtection: WizardRouteDraft = {
    ...draft,
    inherit,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  }
  if (input.classificationReadOk) {
    const interpreted = classificationRulesReconstruct(withProtection, input.classificationRules)
    load.classification = interpreted
    if (interpreted === 'inherited') {
      inherit.classification = true
    } else if (interpreted === 'hydrated') {
      inherit.classification = false
    }
  }

  if (input.policyReadOk) {
    const interpreted = policyOverrideReconstruct(input.policyOverrides, input.routeId)
    if (interpreted.kind === 'inherited') {
      load.policy = 'inherited'
      inherit.policy = true
      delete overrides.policy
    } else if (interpreted.kind === 'hydrated') {
      load.policy = 'hydrated'
      inherit.policy = false
      overrides.policy = { deliveryBehavior: interpreted.deliveryBehavior }
    } else {
      load.policy = 'passthrough'
    }
  }

  return {
    ...draft,
    inherit,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    governanceLoad: load,
  }
}

/**
 * Load existing route governance before an edit save.
 * A failed read marks that concern unavailable and does not coerce it to Inherited.
 */
export async function hydrateRouteGovernanceDrafts(
  streamId: number,
  drafts: WizardRouteDraft[],
): Promise<WizardRouteDraft[]> {
  let governance: Awaited<ReturnType<typeof fetchStreamGovernance>>
  try {
    governance = await fetchStreamGovernance(streamId)
  } catch {
    governance = null
  }
  const policyReadOk = governance != null
  const policyOverrides = governance?.route_overrides ?? []
  const next: WizardRouteDraft[] = []
  for (const draft of drafts) {
    const routeId = Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN)
    if (!Number.isFinite(routeId) || routeId <= 0) {
      next.push(draft)
      continue
    }
    const [protectionResult, classificationResult] = await Promise.all([
      fetchRouteProtectionRules(routeId).catch(() => null),
      fetchRouteClassificationRules(routeId).catch(() => null),
    ])
    next.push(
      applyRouteGovernanceHydration(draft, {
        routeId,
        protectionReadOk: protectionResult != null,
        protectionRules: protectionResult?.rules ?? [],
        classificationReadOk: classificationResult != null,
        classificationRules: classificationResult?.rules ?? [],
        policyReadOk,
        policyOverrides,
      }),
    )
  }
  return next
}
