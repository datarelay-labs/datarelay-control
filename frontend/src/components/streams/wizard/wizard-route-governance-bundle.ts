import type { ClassificationLevel } from '../../../api/gdcClassification'
import type { PolicyActionType } from '../../../api/gdcPolicy'
import { wizardProtectionActionToMode, type ProtectionMode } from '../../../api/gdcProtection'
import {
  createRouteClassificationRule,
  deleteRouteClassificationRule,
  fetchRouteClassificationEffective,
  fetchRouteClassificationRules,
  type RouteClassificationRule,
} from '../../../api/gdcRouteClassification'
import {
  createRoutePolicyRule,
  deleteRoutePolicyRule,
  fetchRoutePolicyEffective,
  fetchRoutePolicyRules,
  type RoutePolicyRule,
} from '../../../api/gdcRoutePolicy'
import {
  createRouteProtectionRule,
  deleteRouteProtectionRule,
  fetchRouteProtectionEffective,
  fetchRouteProtectionRules,
  type RouteProtectionRule,
} from '../../../api/gdcRouteProtection'
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

type PolicyRuleBody = {
  name: string
  enabled: boolean
  condition_json: { sensitivity_class: WizardSensitivityClass }
  action_type: PolicyActionType
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

function deliveryBehaviorToPolicyAction(behavior: WizardDeliveryBehavior): PolicyActionType {
  if (behavior === 'continue') return 'audit_only'
  return 'quarantine'
}

function policyRuleName(sensitivityClass: WizardSensitivityClass): string {
  switch (sensitivityClass) {
    case 'secret':
      return 'Wizard route: secret delivery'
    case 'security_metadata':
      return 'Wizard route: security metadata delivery'
    default:
      return 'Wizard route: personal data delivery'
  }
}

export function routePolicyOverridePersistPayload(draft: WizardRouteDraft): PolicyRuleBody[] | null {
  if (draft.inherit.policy !== false) return null
  const behavior = draft.overrides?.policy?.deliveryBehavior
  if (behavior !== 'continue' && behavior !== 'quarantine' && behavior !== 'block') return null
  const classes = new Set<WizardSensitivityClass>()
  for (const intent of routeProtectionIntents(draft)) {
    if (!wizardDataProtectionIntentReady(intent)) continue
    classes.add(inferWizardSensitivityClass(normalizeWizardDetectedField(intent.detectedField)))
  }
  const targets: WizardSensitivityClass[] = classes.size > 0 ? [...classes] : ['pii']
  const actionType = deliveryBehaviorToPolicyAction(behavior)
  return targets.map((sensitivityClass) => ({
    name: policyRuleName(sensitivityClass),
    enabled: true,
    condition_json: { sensitivity_class: sensitivityClass },
    action_type: actionType,
  }))
}

export function hasPersistableRouteProtectionOverride(draft: WizardRouteDraft): boolean {
  return routeProtectionOverridePersistPayload(draft) != null
}

export function hasPersistableRouteClassificationOverride(draft: WizardRouteDraft): boolean {
  return routeClassificationOverridePersistPayload(draft) != null
}

export function hasPersistableRoutePolicyOverride(draft: WizardRouteDraft): boolean {
  return routePolicyOverridePersistPayload(draft) != null
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
  const payload =
    concern === 'protection'
      ? routeProtectionOverridePersistPayload(draft)
      : concern === 'classification'
        ? routeClassificationOverridePersistPayload(draft)
        : routePolicyOverridePersistPayload(draft)
  const inherited =
    concern === 'protection'
      ? draft.inherit.protection !== false
      : concern === 'classification'
        ? draft.inherit.classification !== false
        : draft.inherit.policy !== false

  if (!inherited && payload == null) return null
  const governance = hasGovernanceOverrideForConcern(concern, draft, dataProtection)
  if (inherited) return governance ? 'governance_retained' : 'Inherited'
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

function policyReadBackMatches(desired: PolicyRuleBody[], rules: RoutePolicyRule[]): boolean {
  if (rules.length !== desired.length) return false
  const byClass = new Map(
    rules.map((rule) => [String(rule.condition_json?.sensitivity_class ?? ''), rule]),
  )
  return desired.every((rule) => {
    const actual = byClass.get(rule.condition_json.sensitivity_class)
    return actual != null && actual.enabled !== false && actual.action_type === rule.action_type
  })
}

async function replaceProtectionRules(routeId: number, desired: ProtectionRuleBody[]): Promise<string | null> {
  let existing
  try {
    existing = await fetchRouteProtectionRules(routeId)
  } catch (err) {
    return `route ${routeId} protection rules: ${errorText(err)}`
  }
  if (existing == null) {
    return `route ${routeId} protection: rules read-back returned no result`
  }
  for (const rule of existing.rules) {
    try {
      await deleteRouteProtectionRule(routeId, rule.id)
    } catch (err) {
      return `route ${routeId} protection: ${errorText(err)}`
    }
  }
  for (const body of desired) {
    try {
      const created = await createRouteProtectionRule(routeId, body)
      if (created == null) return `route ${routeId} protection: create returned no result`
    } catch (err) {
      return `route ${routeId} protection: ${errorText(err)}`
    }
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
  let existing
  try {
    existing = await fetchRouteClassificationRules(routeId)
  } catch (err) {
    return `route ${routeId} classification rules: ${errorText(err)}`
  }
  if (existing == null) {
    return `route ${routeId} classification: rules read-back returned no result`
  }
  for (const rule of existing.rules) {
    try {
      await deleteRouteClassificationRule(routeId, rule.id)
    } catch (err) {
      return `route ${routeId} classification: ${errorText(err)}`
    }
  }
  for (const body of desired) {
    try {
      const created = await createRouteClassificationRule(routeId, body)
      if (created == null) return `route ${routeId} classification: create returned no result`
    } catch (err) {
      return `route ${routeId} classification: ${errorText(err)}`
    }
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

async function replacePolicyRules(routeId: number, desired: PolicyRuleBody[]): Promise<string | null> {
  let existing
  try {
    existing = await fetchRoutePolicyRules(routeId)
  } catch (err) {
    return `route ${routeId} policy rules: ${errorText(err)}`
  }
  if (existing == null) {
    return `route ${routeId} policy: rules read-back returned no result`
  }
  for (const rule of existing.rules) {
    try {
      await deleteRoutePolicyRule(routeId, rule.id)
    } catch (err) {
      return `route ${routeId} policy: ${errorText(err)}`
    }
  }
  for (const body of desired) {
    try {
      const created = await createRoutePolicyRule(routeId, body)
      if (created == null) return `route ${routeId} policy: create returned no result`
    } catch (err) {
      return `route ${routeId} policy: ${errorText(err)}`
    }
  }
  let readBack
  try {
    readBack = await fetchRoutePolicyRules(routeId)
  } catch (err) {
    return `route ${routeId} policy rules: ${errorText(err)}`
  }
  if (readBack == null) return `route ${routeId} policy: rules read-back returned no result`
  if (!policyReadBackMatches(desired, readBack.rules)) {
    return `route ${routeId} policy: rules read-back did not match the saved override`
  }
  return null
}

/**
 * Persist or clear route Protection, Classification, and Policy bundles.
 * Draft keys bind to route ids; a missing id does not shift later drafts.
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

    const protection = routeProtectionOverridePersistPayload(draft)
    if (draft.inherit.protection !== false || protection != null) {
      const message = await replaceProtectionRules(routeId, protection ?? [])
      if (message) errors.push(message)
    }

    const classification = routeClassificationOverridePersistPayload(draft)
    if (draft.inherit.classification !== false || classification != null) {
      const message = await replaceClassificationRules(routeId, classification ?? [])
      if (message) errors.push(message)
    }

    const policy = routePolicyOverridePersistPayload(draft)
    if (draft.inherit.policy !== false || policy != null) {
      const message = await replacePolicyRules(routeId, policy ?? [])
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
      const expected = expectedRouteGovernanceProcessingStatus(concern, draft, dataProtection)
      if (expected == null) continue
      const message = await verifyConcernEffective(concern, routeId, expected)
      if (message) errors.push(message)
    }
  }
  return errors
}
