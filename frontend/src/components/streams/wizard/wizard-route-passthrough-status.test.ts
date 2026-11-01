import { describe, expect, it } from 'vitest'
import {
  buildInitialState,
  computeWizardRouteProcessingStatuses,
  normalizeWizardRouteDraft,
  type WizardRouteDraft,
} from './wizard-state'

// F-158: a Route that owns protection rules the Wizard cannot represent (API-created, disabled, other
// sensitivity class) is hydrated as `passthrough`. Those rules are enforced at runtime, so the Route
// card must not read "Shared".

function draftWith(load: Partial<NonNullable<WizardRouteDraft['governanceLoad']>>): WizardRouteDraft {
  return normalizeWizardRouteDraft({
    key: 'route-1',
    destinationId: 5,
    governanceLoad: { protection: 'inherited', classification: 'inherited', policy: 'inherited', ...load },
  })
}

describe('route card status for passthrough governance (F-158)', () => {
  const dataProtection = buildInitialState().dataProtection

  it('reads Overridden, not Shared, when the Route owns rules the Wizard cannot edit', () => {
    const statuses = computeWizardRouteProcessingStatuses(draftWith({ protection: 'passthrough' }), dataProtection)
    expect(statuses.protection).toBe('Overridden')
    expect(statuses.classification).toBe('Inherited')
    expect(statuses.policy).toBe('Inherited')
  })

  it('applies the same rule to classification and policy', () => {
    const statuses = computeWizardRouteProcessingStatuses(
      draftWith({ classification: 'passthrough', policy: 'passthrough' }),
      dataProtection,
    )
    expect(statuses.classification).toBe('Overridden')
    expect(statuses.policy).toBe('Overridden')
  })

  it('keeps Inherited when the Route verifiably has no rules', () => {
    const statuses = computeWizardRouteProcessingStatuses(draftWith({}), dataProtection)
    expect([statuses.protection, statuses.classification, statuses.policy]).toEqual([
      'Inherited',
      'Inherited',
      'Inherited',
    ])
  })
})
