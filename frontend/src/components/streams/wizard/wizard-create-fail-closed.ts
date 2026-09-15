import type { WizardCreateOutcome } from './wizard-state'

/**
 * Fail-closed start eligibility after multi-step wizard persist.
 * A stream id alone is not enough: any accumulated persist error blocks Start / auto-start
 * and keeps the local draft so the operator can repair.
 */
export function wizardCreateIsStartEligible(outcome: WizardCreateOutcome | null | undefined): boolean {
  if (outcome == null) return false
  if (outcome.streamId == null) return false
  if (outcome.errors.length > 0) return false
  return true
}

export function wizardCreateIsConfigurationIncomplete(
  outcome: WizardCreateOutcome | null | undefined,
): boolean {
  return outcome != null && outcome.streamId != null && outcome.errors.length > 0
}
