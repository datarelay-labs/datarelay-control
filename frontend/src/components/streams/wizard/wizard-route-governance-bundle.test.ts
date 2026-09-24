import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT, type WizardRouteDraft } from './wizard-state'

const fetchRouteProtectionRules = vi.fn()
const replaceRouteProtectionRules = vi.fn()
const fetchRouteProtectionEffective = vi.fn()
const fetchRouteClassificationRules = vi.fn()
const replaceRouteClassificationRules = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRoutePolicyRules = vi.fn()
const fetchRoutePolicyEffective = vi.fn()
const fetchStreamGovernance = vi.fn()

vi.mock('../../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionRules: (...args: unknown[]) => fetchRouteProtectionRules(...args),
  replaceRouteProtectionRules: (...args: unknown[]) => replaceRouteProtectionRules(...args),
  fetchRouteProtectionEffective: (...args: unknown[]) => fetchRouteProtectionEffective(...args),
}))

vi.mock('../../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationRules: (...args: unknown[]) => fetchRouteClassificationRules(...args),
  replaceRouteClassificationRules: (...args: unknown[]) => replaceRouteClassificationRules(...args),
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
}))

vi.mock('../../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyRules: (...args: unknown[]) => fetchRoutePolicyRules(...args),
  fetchRoutePolicyEffective: (...args: unknown[]) => fetchRoutePolicyEffective(...args),
}))

vi.mock('../../../api/gdcStreamGovernance', () => ({
  fetchStreamGovernance: (...args: unknown[]) => fetchStreamGovernance(...args),
}))

import {
  applyRouteGovernanceHydration,
  hydrateRouteGovernanceDrafts,
  persistWizardRouteGovernanceBundles,
  routeGovernanceConcernDisposition,
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

function policyBundleDraft(key: string, behavior: 'continue' | 'quarantine' | 'block' = 'block'): WizardRouteDraft {
  return draft({
    key,
    inherit: { transform: true, protection: true, classification: true, policy: false },
    overrides: { policy: { deliveryBehavior: behavior } },
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
    const protectionByRoute = new Map<number, unknown[]>()
    const classificationByRoute = new Map<number, unknown[]>()
    replaceRouteProtectionRules.mockImplementation(async (routeId: number, rules: unknown[]) => {
      protectionByRoute.set(routeId, rules)
      return { ...emptyRules(routeId), rules, rule_count: rules.length }
    })
    replaceRouteClassificationRules.mockImplementation(async (routeId: number, rules: unknown[]) => {
      classificationByRoute.set(routeId, rules)
      return { ...emptyRules(routeId), rules, rule_count: rules.length }
    })
    fetchRouteProtectionRules.mockImplementation(async (routeId: number) => ({
      ...emptyRules(routeId),
      rules: protectionByRoute.get(routeId) ?? [],
      rule_count: (protectionByRoute.get(routeId) ?? []).length,
    }))
    fetchRouteClassificationRules.mockImplementation(async (routeId: number) => ({
      ...emptyRules(routeId),
      rules: classificationByRoute.get(routeId) ?? [],
      rule_count: (classificationByRoute.get(routeId) ?? []).length,
    }))
    fetchRoutePolicyRules.mockImplementation(async (routeId: number) => emptyRules(routeId))
    fetchRouteProtectionEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    fetchStreamGovernance.mockResolvedValue({ stream_id: 100, enabled: false, rules: [], route_overrides: [] })
  })

  it('persists protection, reads rules back, and matches Effective Overridden', async () => {
    const errors = await persistWizardRouteGovernanceBundles([protectionBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).toHaveBeenCalledWith(22, [
      {
        field_path: '$.email',
        sensitivity_class: 'pii',
        protection_mode: 'partial_mask',
        enabled: true,
      },
    ])
    expect(fetchRouteProtectionRules).toHaveBeenCalledWith(22)

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
    const errors = await persistWizardRouteGovernanceBundles([classificationBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteClassificationRules).toHaveBeenCalledWith(
      22,
      expect.arrayContaining([
        expect.objectContaining({
          condition_json: { sensitivity_class: 'pii' },
          classification_level: 'CONFIDENTIAL',
        }),
      ]),
    )
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [classificationBundleDraft('wr-b')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
  })

  it('does not translate policy block into a route policy rule', async () => {
    const errors = await persistWizardRouteGovernanceBundles([policyBundleDraft('wr-b', 'block')], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).toHaveBeenCalledWith(22, [])
    expect(replaceRouteClassificationRules).toHaveBeenCalledWith(22, [])
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b', 'block')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
  })

  it('expects Mixed when governance policy override coexists with route policy rules', async () => {
    fetchRoutePolicyRules.mockImplementation(async (routeId: number) => ({
      ...emptyRules(routeId),
      rules: [{ id: 5, enabled: true, action_type: 'quarantine' }],
      rule_count: 1,
    }))
    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Mixed'))
    const matched = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b', 'block')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(matched).toEqual([])

    fetchRoutePolicyEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const mismatch = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b', 'block')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(mismatch).toEqual(['route 22 policy: expected Mixed after save, Effective API returned Overridden'])
  })

  it('reports protection replace failure without a follow-up clear', async () => {
    replaceRouteProtectionRules.mockRejectedValue(new Error('conflict'))
    const errors = await persistWizardRouteGovernanceBundles([protectionBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual(['route 22 protection: conflict'])
    expect(fetchRouteProtectionRules).not.toHaveBeenCalled()
  })

  it('reports classification replace failure', async () => {
    replaceRouteClassificationRules.mockRejectedValue(new Error('invalid level'))
    const errors = await persistWizardRouteGovernanceBundles([classificationBundleDraft('wr-b')], { 'wr-b': 22 })
    expect(errors).toEqual(['route 22 classification: invalid level'])
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
      [policyBundleDraft('wr-b', 'quarantine')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(mismatch).toEqual(['route 22 policy: expected Overridden after save, Effective API returned Inherited'])

    fetchRoutePolicyEffective.mockResolvedValue(null)
    const missing = await verifyWizardRouteGovernanceEffective(
      [policyBundleDraft('wr-b', 'quarantine')],
      { 'wr-b': 22 },
      buildInitialState().dataProtection,
    )
    expect(missing).toEqual(['route 22 policy: Effective API returned no result (expected Overridden)'])
  })

  it('binds bundles to draft keys when an earlier route create failed', async () => {
    const errors = await persistWizardRouteGovernanceBundles(
      [protectionBundleDraft('wr-a'), protectionBundleDraft('wr-b')],
      { 'wr-b': 22 },
    )
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).toHaveBeenCalledTimes(1)
    expect(replaceRouteProtectionRules).toHaveBeenCalledWith(
      22,
      expect.arrayContaining([expect.objectContaining({ field_path: '$.email' })]),
    )
  })

  it('clears loaded inherited protection and classification without deleting policy rules', async () => {
    const inherited = draft({
      key: 'route-22',
      governanceLoad: { protection: 'inherited', classification: 'inherited', policy: 'inherited' },
    })
    const errors = await persistWizardRouteGovernanceBundles([inherited], { 'route-22': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).toHaveBeenCalledWith(22, [])
    expect(replaceRouteClassificationRules).toHaveBeenCalledWith(22, [])

    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [inherited],
      { 'route-22': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
  })

  it('does not mutate a concern that failed to load', async () => {
    const unavailable = draft({
      key: 'route-22',
      governanceLoad: { protection: 'unavailable', classification: 'unavailable', policy: 'unavailable' },
    })
    const errors = await persistWizardRouteGovernanceBundles([unavailable], { 'route-22': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).not.toHaveBeenCalled()
    expect(replaceRouteClassificationRules).not.toHaveBeenCalled()
    const verifyErrors = await verifyWizardRouteGovernanceEffective(
      [unavailable],
      { 'route-22': 22 },
      buildInitialState().dataProtection,
    )
    expect(verifyErrors).toEqual([])
    expect(fetchRouteProtectionEffective).not.toHaveBeenCalled()
  })

  it('distinguishes persisted inherited from unavailable', () => {
    const inherited = draft({
      key: 'route-22',
      governanceLoad: { protection: 'inherited', classification: 'inherited', policy: 'inherited' },
    })
    const unavailable = draft({
      key: 'route-22',
      governanceLoad: { protection: 'unavailable', classification: 'passthrough', policy: 'unloaded' },
    })
    expect(routeGovernanceConcernDisposition(inherited, 'protection')).toBe('clear')
    expect(routeGovernanceConcernDisposition(unavailable, 'protection')).toBe('skip')
    expect(routeGovernanceConcernDisposition(unavailable, 'classification')).toBe('skip')
    expect(routeGovernanceConcernDisposition(unavailable, 'policy')).toBe('skip')
  })

  it('does not persist an empty protection or policy override', async () => {
    const empty = draft({
      key: 'wr-b',
      inherit: { transform: true, protection: false, classification: false, policy: false },
    })
    const errors = await persistWizardRouteGovernanceBundles([empty], { 'wr-b': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).not.toHaveBeenCalled()
    expect(replaceRouteClassificationRules).not.toHaveBeenCalled()

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
    const inherited = draft({
      key: 'route-22',
      governanceLoad: { protection: 'inherited', classification: 'inherited', policy: 'inherited' },
    })
    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Overridden'))
    const kept = await verifyWizardRouteGovernanceEffective([inherited], { 'route-22': 22 }, state.dataProtection)
    expect(kept.filter((error) => error.includes('classification'))).toEqual([])

    fetchRouteClassificationEffective.mockImplementation(async (routeId: number) => effective(routeId, 'Inherited'))
    const lost = await verifyWizardRouteGovernanceEffective([inherited], { 'route-22': 22 }, state.dataProtection)
    expect(lost).toContain(
      'route 22 classification: expected Mixed or Overridden after save, Effective API returned Inherited',
    )
  })

  it('hydrates existing protection, classification, and policy block for an unrelated edit', async () => {
    fetchRouteProtectionRules.mockResolvedValue({
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
          created_by: 'operator',
          created_at: '',
          updated_at: '',
        },
      ],
      rule_count: 1,
    })
    fetchRouteClassificationRules.mockResolvedValue({
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
    fetchStreamGovernance.mockResolvedValue({
      stream_id: 100,
      enabled: true,
      rules: [],
      route_overrides: [
        {
          field_path: '$.ssn',
          route_id: 22,
          protection_action: 'hash',
          delivery_behavior: 'continue',
          enabled: true,
        },
        { field_path: null, route_id: 22, delivery_behavior: 'block', enabled: true },
      ],
    })

    const [hydrated] = await hydrateRouteGovernanceDrafts(100, [draft({ key: 'route-22' })])
    expect(hydrated.governanceLoad).toEqual({
      protection: 'hydrated',
      classification: 'hydrated',
      policy: 'hydrated',
    })
    expect(hydrated.inherit.protection).toBe(false)
    expect(hydrated.inherit.classification).toBe(false)
    expect(hydrated.overrides?.policy?.deliveryBehavior).toBe('block')

    const errors = await persistWizardRouteGovernanceBundles([hydrated], { 'route-22': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).toHaveBeenCalledWith(
      22,
      expect.arrayContaining([expect.objectContaining({ field_path: '$.email', protection_mode: 'partial_mask' })]),
    )
    expect(replaceRouteClassificationRules).toHaveBeenCalledWith(
      22,
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Wizard route: personal data classification',
          classification_level: 'CONFIDENTIAL',
        }),
      ]),
    )
  })

  it('keeps an unreadable concern unchanged and does not treat a read failure as inherited', async () => {
    fetchRouteProtectionRules.mockResolvedValue(null)
    fetchRouteClassificationRules.mockResolvedValue({ ...emptyRules(22), rules: [], rule_count: 0 })
    fetchStreamGovernance.mockResolvedValue(null)

    const [hydrated] = await hydrateRouteGovernanceDrafts(100, [draft({ key: 'route-22' })])
    expect(hydrated.governanceLoad?.protection).toBe('unavailable')
    expect(hydrated.governanceLoad?.classification).toBe('inherited')
    expect(hydrated.governanceLoad?.policy).toBe('unavailable')
    expect(routeGovernanceConcernDisposition(hydrated, 'protection')).toBe('skip')
    expect(routeGovernanceConcernDisposition(hydrated, 'classification')).toBe('clear')
    expect(routeGovernanceConcernDisposition(hydrated, 'policy')).toBe('skip')

    const errors = await persistWizardRouteGovernanceBundles([hydrated], { 'route-22': 22 })
    expect(errors).toEqual([])
    expect(replaceRouteProtectionRules).not.toHaveBeenCalled()
    expect(replaceRouteClassificationRules).toHaveBeenCalledWith(22, [])
  })

  it('passes through a protection bundle that cannot be reconstructed', () => {
    const hydrated = applyRouteGovernanceHydration(draft({ key: 'route-22' }), {
      routeId: 22,
      protectionReadOk: true,
      protectionRules: [
        {
          id: 1,
          route_id: 22,
          stream_id: 100,
          field_path: '$.email',
          sensitivity_class: 'pii',
          protection_mode: 'partial_mask',
          enabled: false,
          source_finding_id: null,
          created_by: 'operator',
          created_at: '',
          updated_at: '',
        },
      ],
      classificationReadOk: true,
      classificationRules: [],
      policyReadOk: true,
      policyOverrides: [],
    })
    expect(hydrated.governanceLoad?.protection).toBe('passthrough')
    expect(routeGovernanceConcernDisposition(hydrated, 'protection')).toBe('skip')
  })
})
