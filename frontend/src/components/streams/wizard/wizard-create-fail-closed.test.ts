import { describe, expect, it } from 'vitest'
import {
  wizardCreateIsConfigurationIncomplete,
  wizardCreateIsStartEligible,
} from './wizard-create-fail-closed'
import type { WizardCreateOutcome } from './wizard-state'

function outcome(partial: Partial<WizardCreateOutcome>): WizardCreateOutcome {
  return {
    streamId: null,
    routeId: null,
    routeIds: [],
    mappingSaved: false,
    enrichmentSaved: false,
    dataProtectionSaved: false,
    governanceSaved: false,
    schemaDriftPolicySaved: false,
    schemaDriftPolicyWarnings: [],
    dataProtectionEnforcementIncomplete: false,
    dataProtectionWarnings: [],
    errors: [],
    apiBacked: true,
    createdAt: null,
    materializedStreamIds: [],
    ...partial,
  }
}

describe('wizard create fail-closed', () => {
  it('blocks start when stream exists but persist errors accumulated', () => {
    const o = outcome({ streamId: 42, errors: ['POST /routes/ failed'] })
    expect(wizardCreateIsStartEligible(o)).toBe(false)
    expect(wizardCreateIsConfigurationIncomplete(o)).toBe(true)
  })

  it('blocks start when a route governance bundle read-back or Effective check fails', () => {
    const o = outcome({
      streamId: 42,
      routeIds: [7],
      errors: ['route 7 protection: expected Overridden after save, Effective API returned Inherited'],
    })
    expect(wizardCreateIsStartEligible(o)).toBe(false)
    expect(wizardCreateIsConfigurationIncomplete(o)).toBe(true)
  })

  it('allows start only when stream created with zero persist errors', () => {
    const o = outcome({ streamId: 7, errors: [] })
    expect(wizardCreateIsStartEligible(o)).toBe(true)
    expect(wizardCreateIsConfigurationIncomplete(o)).toBe(false)
  })

  it('treats missing stream as not start-eligible', () => {
    expect(wizardCreateIsStartEligible(outcome({ streamId: null, errors: [] }))).toBe(false)
    expect(wizardCreateIsStartEligible(null)).toBe(false)
  })
})
