import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT, type WizardRouteDraft } from './wizard-state'

const fetchRouteProtectionRules = vi.fn()
const createRouteProtectionRule = vi.fn()
const deleteRouteProtectionRule = vi.fn()
const fetchRouteProtectionEffective = vi.fn()
const fetchRouteClassificationRules = vi.fn()
const createRouteClassificationRule = vi.fn()
const deleteRouteClassificationRule = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRoutePolicyRules = vi.fn()
const createRoutePolicyRule = vi.fn()
const deleteRoutePolicyRule = vi.fn()
const fetchRoutePolicyEffective = vi.fn()

vi.mock('../../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionRules: (...args: unknown[]) => fetchRouteProtectionRules(...args),
  createRouteProtectionRule: (...args: unknown[]) => createRouteProtectionRule(...args),
  deleteRouteProtectionRule: (...args: unknown[]) => deleteRouteProtectionRule(...args),
  fetchRouteProtectionEffective: (...args: unknown[]) => fetchRouteProtectionEffective(...args),
}))

vi.mock('../../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationRules: (...args: unknown[]) => fetchRouteClassificationRules(...args),
  createRouteClassificationRule: (...args: unknown[]) => createRouteClassificationRule(...args),
  deleteRouteClassificationRule: (...args: unknown[]) => deleteRouteClassificationRule(...args),
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
}))

vi.mock('../../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyRules: (...args: unknown[]) => fetchRoutePolicyRules(...args),
  createRoutePolicyRule: (...args: unknown[]) => createRoutePolicyRule(...args),
  deleteRoutePolicyRule: (...args: unknown[]) => deleteRoutePolicyRule(...args),
  fetchRoutePolicyEffective: (...args: unknown[]) => fetchRoutePolicyEffective(...args),
}))

import {
  persistWizardRouteGovernanceBundles,
  verifyWizardRouteGovernanceEffective,
} from './wizard-route-governance-bundle'

function draft(partial: Partial<WizardRouteDraft> & Pick<WizardRouteDraft, 'key'>): WizardRouteDraft {
  return {
    destinationId: 10,
    enabled: true,
    failurePolicy: 'LOG_AND_CONTINUE',
    rateLimitJson: {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    ...partial,
  }
}

const emailIntent = {
  key: 'i1',
  detectedField: '$.email',
  protectionAction: 'mask_partial' as const,
  deliveryBehavior: 'quarantine' as const,
}

function protectionBundleDraft(key: string): WizardRouteDraft {
  return draft({
    key,
    inherit: { transform: true, protection: false, classification: true, policy: true },
    overrides: {
      protection: {
        intents: [emailIntent],
        unknownNormalFieldPolicy: 'pass_through',
        unknownSensitiveFieldPolicy: 'auto_protect',
      },
    },
  })
}

function classificationBundleDraft(key: string): WizardRouteDraft {
  return draft({
    key,
    inherit: { transform: true, protection: true, classification: false, policy: true },
    overrides: {
      protection: {
        intents: [emailIntent],
        unknownNormalFieldPolicy: 'pass_through',
        unknownSensitiveFieldPolicy: 'auto_protect',
      },
    },
  })
}

function policyBundleDraft(key: string): WizardRouteDraft {
  return draft({
    key,
    inherit: { transform: true, protection: true, classification: true, policy: false },
    overrides: {
      policy: { deliveryBehavior: 'quarantine' },
      protection: {
        intents: [emailIntent],
        unknownNormalFieldPolicy: 'pass_through',
        unknownSensitiveFieldPolicy: 'auto_protect',
      },
    },
  })
}

function emptyRules(routeId: number) {
  return { route_id: routeId, stream_id: 100, rules: [], rule_count: 0, protection_enabled: true }
}

function effective(routeId: number, processing_status: 'Inherited' | 'Overridden' | 'Mixed') {
  return {
    route_id: routeId,
    stream_id: 100,
    persisted_source: processing_status === 'Inherited' ? 'stream' : 'route',
    fallback_used: processing_status === 'Inherited',
    rule_count: processing_status === 'Inherited' ? 0 : 1,
    processing_status,
    message: 'ok',
  }
}

describe('wizard route governance bundles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRouteProtectionRules.mockImplementation(async (routeId: number) => emptyRules(routeId))
    fetchRouteClassificationRules.mockImplementation(async (routeId: number) => emptyRules(routeId))
    fetchRoutePolicyRules.mockImplementation(async (routeId: number) => emptyRules(routeId))
    createRouteProtectionRule.mockImplementation(async () => ({ rule: { id: 1 } }))
    createRouteClassificationRule.mockImplementation(async () => ({ rule: { id: 2 } }))
    createRoutePolicyRule.mockImplementation(async () => ({ rule: { id: 3 } }))
    deleteRouteProtectionRule.mockResolvedValue(undefined)
    deleteRouteClassificationRule.mockResolvedValue(undefined)
    deleteRoutePolicyRule.mockResolvedValue(undefined)
    fetchRouteProtectionEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
  })

  it('persists protection, reads rules back, and matches Effective Overridden', async () => {
    fetchRouteProtectionRules
      .mockResolvedValueOnce(emptyRules(22))
      .mockResolvedValueOnce({
        ...emptyRules(22),
        rules: [
          {
            id: 8,
            route_id: 22,
            stream_id: 100,
            field_path: '$.email',
            sensitivity_class: 'pii',
            protection_mode: 'partial_mask',
            enabled: true,
            source_finding_id: null,
            created_by: 'wizard',
            created_at: '',
            updated_at: '',
          },
        ],
        rule_count: 1,
      })

    const errors = await persistWizardRouteGovernanceBundles([protectionBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(createRouteProtectionRule).toHaveBeenCalledWith(22, {
      field_path: '$.email',
      sensitivity_class: 'pii',
      protection_mode: 'partial_mask',
      enabled: true,
    })

    fetchRouteProtectionEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
    expect(fetchRouteProtectionEffective).toHaveBeenCalledWith(22)
  })

  it('persists classification from route protection intents and matches Effective', async () => {
    fetchRouteClassificationRules
      .mockResolvedValueOnce(emptyRules(22))
      .mockResolvedValueOnce({
        ...emptyRules(22),
        rules: [
          {
            id: 4,
            route_id: 22,
            stream_id: 100,
            name: 'Wizard route: personal data classification',
            enabled: true,
            condition_json: { sensitivity_class: 'pii' },
            classification_level: 'CONFIDENTIAL',
            created_at: '',
            updated_at: '',
          },
        ],
        rule_count: 1,
      })

    const errors = await persistWizardRouteGovernanceBundles([classificationBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(createRouteClassificationRule).toHaveBeenCalledWith(
      22,
      expect.objectContaining({
        condition_json: { sensitivity_class: 'pii' },
        classification_level: 'CONFIDENTIAL',
      }),
    )
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [classificationBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
  })

  it('persists policy delivery behavior and matches Effective', async () => {
    fetchRoutePolicyRules
      .mockResolvedValueOnce(emptyRules(22))
      .mockResolvedValueOnce({
        ...emptyRules(22),
        rules: [
          {
            id: 5,
            route_id: 22,
            stream_id: 100,
            name: 'Wizard route: personal data delivery',
            enabled: true,
            condition_json: { sensitivity_class: 'pii' },
            action_type: 'quarantine',
            created_at: '',
            updated_at: '',
          },
        ],
        rule_count: 1,
      })

    const errors = await persistWizardRouteGovernanceBundles([policyBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(createRoutePolicyRule).toHaveBeenCalledWith(
      22,
      expect.objectContaining({
        condition_json: { sensitivity_class: 'pii' },
        action_type: 'quarantine',
      }),
    )
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
  })

  it('reports protection persist failure', async () => {
    createRouteProtectionRule.mockRejectedValue(new Error('conflict'))
    const errors = await persistWizardRouteGovernanceBundles([protectionBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual(['route 22 protection: conflict'])
  })

  it('reports classification persist failure', async () => {
    createRouteClassificationRule.mockRejectedValue(new Error('invalid level'))
    const errors = await persistWizardRouteGovernanceBundles([classificationBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual(['route 22 classification: invalid level'])
  })

  it('reports policy persist failure', async () => {
    createRoutePolicyRule.mockRejectedValue(new Error('rejected'))
    const errors = await persistWizardRouteGovernanceBundles([policyBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual(['route 22 policy: rejected'])
  })

  it('fails closed when protection Effective mismatches or is missing', async () => {
    fetchRouteProtectionEffective.mockResolvedValue(effective(22, 'Inherited'))
    const mismatch = await verifyWizardRouteGovernanceEffective(
      [protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(mismatch).toEqual([
      'route 22 protection: expected Overridden after save, Effective API returned Inherited',
    ])

    fetchRouteProtectionEffective.mockResolvedValue(null)
    const missing = await verifyWizardRouteGovernanceEffective(
      [protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(missing).toEqual(['route 22 protection: Effective API returned no result (expected Overridden)'])
  })

  it('fails closed when classification Effective mismatches or is missing', async () => {
    fetchRouteClassificationEffective.mockRejectedValue(new Error('network down'))
    const failed = await verifyWizardRouteGovernanceEffective(
      [classificationBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(failed).toEqual(['route 22 classification effective: network down'])

    fetchRouteClassificationEffective.mockResolvedValue(null)
    const missing = await verifyWizardRouteGovernanceEffective(
      [classificationBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(missing).toEqual([
      'route 22 classification: Effective API returned no result (expected Overridden)',
    ])
  })

  it('fails closed when policy Effective mismatches or is missing', async () => {
    fetchRoutePolicyEffective.mockResolvedValue(effective(22, 'Inherited'))
    const mismatch = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(mismatch).toEqual(['route 22 policy: expected Overridden after save, Effective API returned Inherited'])

    fetchRoutePolicyEffective.mockResolvedValue(null)
    const missing = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(missing).toEqual(['route 22 policy: Effective API returned no result (expected Overridden)'])
  })

  it('binds bundles to draft keys when an earlier route create failed', async () => {
    fetchRouteProtectionRules.mockImplementation(async () => ({
      ...emptyRules(22),
      rules: [
        {
          id: 8,
          route_id: 22,
          stream_id: 100,
          field_path: '$.email',
          sensitivity_class: 'pii',
          protection_mode: 'partial_mask',
          enabled: true,
          source_finding_id: null,
          created_by: 'wizard',
          created_at: '',
          updated_at: '',
        },
      ],
      rule_count: 1,
    }))
    const errors = await persistWizardRouteGovernanceBundles(
      [protectionBundleDraft('wr-a'), protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
    )
    expect(errors).toEqual([])
    expect(createRouteProtectionRule).toHaveBeenCalledTimes(1)
    expect(createRouteProtectionRule).toHaveBeenCalledWith(22, expect.objectContaining({ field_path: '$.email' }))
    expect(fetchRouteProtectionRules).toHaveBeenCalledWith(22)
    expect(fetchRouteProtectionRules.mock.calls.every((call) => call[0] === 22)).toBe(true)
  })

  it('clears inherited route rules and expects Inherited Effective', async () => {
    fetchRouteProtectionRules
      .mockResolvedValueOnce({
        ...emptyRules(22),
        rules: [
          {
            id: 9,
            route_id: 22,
            stream_id: 100,
            field_path: '$.email',
            sensitivity_class: 'pii',
            protection_mode: 'partial_mask',
            enabled: true,
            source_finding_id: null,
            created_by: 'wizard',
            created_at: '',
            updated_at: '',
          },
        ],
        rule_count: 1,
      })
      .mockResolvedValueOnce(emptyRules(22))
    fetchRouteClassificationRules
      .mockResolvedValueOnce({
        ...emptyRules(22),
        rules: [
          {
            id: 4,
            route_id: 22,
            stream_id: 100,
            name: 'old',
            enabled: true,
            condition_json: { sensitivity_class: 'pii' },
            classification_level: 'INTERNAL',
            created_at: '',
            updated_at: '',
          },
        ],
        rule_count: 1,
      })
      .mockResolvedValueOnce(emptyRules(22))
    fetchRoutePolicyRules
      .mockResolvedValueOnce({
        ...emptyRules(22),
        rules: [
          {
            id: 5,
            route_id: 22,
            stream_id: 100,
            name: 'old',
            enabled: true,
            condition_json: { sensitivity_class: 'pii' },
            action_type: 'audit_only',
            created_at: '',
            updated_at: '',
          },
        ],
        rule_count: 1,
      })
      .mockResolvedValueOnce(emptyRules(22))
    fetchRouteProtectionEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))

    const inherited = draft({ key: 'route-22' })
    const errors = await persistWizardRouteGovernanceBundles([inherited], { 'route-22': 22 })
    expect(errors).toEqual([])
    expect(deleteRouteProtectionRule).toHaveBeenCalledWith(22, 9)
    expect(deleteRouteClassificationRule).toHaveBeenCalledWith(22, 4)
    expect(deleteRoutePolicyRule).toHaveBeenCalledWith(22, 5)
    expect(createRouteProtectionRule).not.toHaveBeenCalled()
    expect(createRouteClassificationRule).not.toHaveBeenCalled()
    expect(createRoutePolicyRule).not.toHaveBeenCalled()

    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [inherited],
      { 'route-22': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
  })

  it('does not persist an empty protection or policy override', async () => {
    const empty = draft({
      key: 'wr-b',
      inherit: { transform: true, protection: false, classification: false, policy: false },
    })
    const errors = await persistWizardRouteGovernanceBundles([empty], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(createRouteProtectionRule).not.toHaveBeenCalled()
    expect(createRouteClassificationRule).not.toHaveBeenCalled()
    expect(createRoutePolicyRule).not.toHaveBeenCalled()
    expect(fetchRouteProtectionRules).not.toHaveBeenCalled()

    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [empty],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
    expect(fetchRouteProtectionEffective).not.toHaveBeenCalled()
    expect(fetchRouteClassificationEffective).not.toHaveBeenCalled()
    expect(fetchRoutePolicyEffective).not.toHaveBeenCalled()
  })

  it('expects Mixed when a persistable bundle also has a field-level governance override', async () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        routeDraftKey: 'wr-b',
        fieldPath: '$.email',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    fetchRouteProtectionEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Mixed'))
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Mixed'))
    const matched = await verifyWizardRouteGovernanceEffective(
      [protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
      state.dataProtection,
    )
    expect(matched).toEqual([])

    fetchRouteProtectionEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const mismatch = await verifyWizardRouteGovernanceEffective(
      [protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
      state.dataProtection,
    )
    expect(mismatch).toEqual(['route 22 protection: expected Mixed after save, Effective API returned Overridden'])
  })

  it('accepts Mixed or Overridden after clearing route rules when governance overrides remain', async () => {
    const state = buildInitialState()
    state.dataProtection.routeClassificationOverrides = [
      {
        key: 'c1',
        routeDraftKey: 'route-22',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      },
    ]
    const inherited = draft({ key: 'route-22' })
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const kept = await verifyWizardRouteGovernanceEffective([inherited], { 'route-22': 22 }, state.dataProtection)
    expect(kept.filter((error) => error.includes('classification'))).toEqual([])

    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    const lost = await verifyWizardRouteGovernanceEffective([inherited], { 'route-22': 22 }, state.dataProtection)
    expect(lost).toContain(
      'route 22 classification: expected Mixed or Overridden after save, Effective API returned Inherited',
    )
  })
})
