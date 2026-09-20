import {
  wizardDataProtectionIntentReady,
  type WizardDataProtectionIntent,
  type WizardDataProtectionState,
  type WizardDeliveryBehavior,
  type WizardUnknownNormalFieldPolicy,
  type WizardUnknownSensitiveFieldPolicy,
} from './wizard-state'

const DELIVERY_LABEL: Record<WizardDeliveryBehavior, string> = {
  continue: 'Continue delivery',
  quarantine: 'Quarantine',
  block: 'Block delivery',
}

const DELIVERY_CONTROLS_SHORT: Record<WizardDeliveryBehavior, string> = {
  continue: 'Continue',
  quarantine: 'Quarantine',
  block: 'Block',
}

const PROTECTION_ACTION_LABEL = {
  audit: 'Audit only',
  mask_partial: 'Mask (partial)',
  mask_full: 'Mask (full)',
  tokenize: 'Tokenize',
  hash: 'Hash',
  drop_field: 'Remove',
} as const

export function protectionActionLabel(action: WizardDataProtectionIntent['protectionAction']): string {
  return PROTECTION_ACTION_LABEL[action]
}

export function deliveryBehaviorLabel(behavior: WizardDeliveryBehavior): string {
  return DELIVERY_LABEL[behavior]
}

export type ProtectionRuleReviewRow = {
  detectedField: string
  protectionAction: string
  deliveryBehavior: string
}

export function protectionRulesReviewRows(intents: readonly WizardDataProtectionIntent[]): ProtectionRuleReviewRow[] {
  return validDataProtectionIntents(intents).map((intent) => ({
    detectedField: intent.detectedField,
    protectionAction: protectionActionLabel(intent.protectionAction),
    deliveryBehavior: deliveryBehaviorLabel(intent.deliveryBehavior),
  }))
}

export function validDataProtectionIntents(intents: readonly WizardDataProtectionIntent[]): WizardDataProtectionIntent[] {
  return intents.filter(wizardDataProtectionIntentReady)
}

export function dataProtectionDeliveryControlsSummary(intents: readonly WizardDataProtectionIntent[]): string {
  const valid = validDataProtectionIntents(intents)
  if (valid.length === 0) return ''
  const seen = new Set<WizardDeliveryBehavior>()
  for (const intent of valid) seen.add(intent.deliveryBehavior)
  const order: WizardDeliveryBehavior[] = ['continue', 'quarantine', 'block']
  return order.filter((b) => seen.has(b)).map((b) => DELIVERY_CONTROLS_SHORT[b]).join(' / ')
}

export const UNKNOWN_NORMAL_FIELD_POLICY_LABEL: Record<WizardUnknownNormalFieldPolicy, string> = {
  pass_through: 'Pass Through',
  require_review: 'Require Review',
  drop_field: 'Drop',
  quarantine: 'Quarantine',
}

export const UNKNOWN_SENSITIVE_FIELD_POLICY_LABEL: Record<WizardUnknownSensitiveFieldPolicy, string> = {
  auto_protect: 'Auto Protect',
  require_review: 'Require Review',
  drop_field: 'Drop',
  quarantine: 'Quarantine',
}

export function schemaDriftPolicyReviewSummary(
  dataProtection: Pick<WizardDataProtectionState, 'unknownNormalFieldPolicy' | 'unknownSensitiveFieldPolicy'>,
): { unknownNormalField: string; unknownSensitiveField: string } {
  return {
    unknownNormalField: UNKNOWN_NORMAL_FIELD_POLICY_LABEL[dataProtection.unknownNormalFieldPolicy],
    unknownSensitiveField: UNKNOWN_SENSITIVE_FIELD_POLICY_LABEL[dataProtection.unknownSensitiveFieldPolicy],
  }
}
