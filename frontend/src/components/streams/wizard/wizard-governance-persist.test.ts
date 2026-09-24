import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRouteDraftKeyToIdMap,
  buildStreamGovernancePayload,
  isDuplicateRouteClassificationOverride,
  isDuplicateRouteOverride,
  mergeStreamGovernanceDocument,
  persistWizardStreamGovernance,
} from './wizard-governance-persist'
import { buildInitialState } from './wizard-state'

const fetchStreamGovernance = vi.fn()
const putStreamGovernance = vi.fn()

vi.mock('../../../api/gdcStreamGovernance', () => ({
  fetchStreamGovernance: (...args: unknown[]) => fetchStreamGovernance(...args),
  putStreamGovernance: (...args: unknown[]) => putStreamGovernance(...args),
}))

describe('wizard-governance-persist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    let stored = {
      stream_id: 42,
      enabled: false,
      rules: [] as Array<Record<string, unknown>>,
      route_overrides: [] as Array<Record<string, unknown>>,
    }
    fetchStreamGovernance.mockImplementation(async () => stored)
    putStreamGovernance.mockImplementation(async (_streamId: number, body: typeof stored) => {
      stored = { stream_id: 42, ...body }
      return stored
    })
  })

  it('maps routeDraftKey to route_id without shifting when an earlier route is missing', () => {
    const drafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE' as const, rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE' as const, rateLimitJson: {} },
    ]
    const map = buildRouteDraftKeyToIdMap(drafts, { r1: 101, r2: 102 })
    expect(map.get('r1')).toBe(101)
    expect(map.get('r2')).toBe(102)

    const partial = buildRouteDraftKeyToIdMap(drafts, { r2: 202 })
    expect(partial.has('r1')).toBe(false)
    expect(partial.get('r2')).toBe(202)
  })

  it('detects duplicate field + route override', () => {
    const overrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize' as const,
        deliveryBehavior: 'continue' as const,
        enabled: true,
      },
    ]
    expect(isDuplicateRouteOverride(overrides, '$.email', 'r1')).toBe(true)
    expect(isDuplicateRouteOverride(overrides, '$.email', 'r2')).toBe(false)
    expect(isDuplicateRouteOverride(overrides, '$.email', 'r1', 'o1')).toBe(false)
  })

  it('builds PUT governance payload from intents and overrides', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
      {
        key: 'o2',
        fieldPath: '$.email',
        routeDraftKey: 'r2',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r1: 501, r2: 502 }),
    )

    expect(payload.enabled).toBe(true)
    expect(payload.rules).toHaveLength(1)
    expect(payload.rules[0]).toMatchObject({
      field_path: '$.email',
      default_protection_action: 'mask_partial',
      default_delivery_behavior: 'continue',
    })
    expect(payload.route_overrides).toEqual([
      {
        field_path: '$.email',
        route_id: 501,
        protection_action: 'tokenize',
        delivery_behavior: 'continue',
        enabled: true,
      },
      {
        field_path: '$.email',
        route_id: 502,
        protection_action: 'mask_full',
        delivery_behavior: 'continue',
        enabled: true,
      },
    ])
  })

  it('keeps field-level overrides on the surviving draft key when an earlier route is missing', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
      {
        key: 'o2',
        fieldPath: '$.ssn',
        routeDraftKey: 'r2',
        protectionAction: 'mask_full',
        deliveryBehavior: 'quarantine',
        enabled: true,
      },
    ]
    state.dataProtection.routeClassificationOverrides = [
      {
        key: 'c2',
        routeDraftKey: 'r2',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r2: 202 }),
    )

    expect(payload.route_overrides).toEqual([
      {
        field_path: '$.ssn',
        route_id: 202,
        protection_action: 'mask_full',
        delivery_behavior: 'quarantine',
        enabled: true,
      },
      { route_id: 202, classification_level: 'RESTRICTED', enabled: true },
    ])
  })

  it('builds classification-only route overrides in governance payload', () => {
    const state = buildInitialState()
    state.dataProtection.routeClassificationOverrides = [
      {
        key: 'c1',
        routeDraftKey: 'r1',
        classificationLevel: 'INTERNAL',
        enabled: true,
      },
      {
        key: 'c2',
        routeDraftKey: 'r2',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r1: 701, r2: 702 }),
    )

    expect(payload.enabled).toBe(true)
    expect(payload.route_overrides).toEqual([
      { route_id: 701, classification_level: 'INTERNAL', enabled: true },
      { route_id: 702, classification_level: 'RESTRICTED', enabled: true },
    ])
  })

  it('detects duplicate route classification override', () => {
    const overrides = [
      {
        key: 'c1',
        routeDraftKey: 'r1',
        classificationLevel: 'INTERNAL' as const,
        enabled: true,
      },
    ]
    expect(isDuplicateRouteClassificationOverride(overrides, 'r1')).toBe(true)
    expect(isDuplicateRouteClassificationOverride(overrides, 'r2')).toBe(false)
    expect(isDuplicateRouteClassificationOverride(overrides, 'r1', 'c1')).toBe(false)
  })

  it('persists governance via PUT after route mapping', async () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const result = await persistWizardStreamGovernance(42, state, { r1: 900 })

    expect(result.saved).toBe(true)
    expect(putStreamGovernance).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({ field_path: '$.email', default_protection_action: 'mask_partial' }),
        ]),
      }),
    )
  })

  it('skips PUT when no governance content', async () => {
    const state = buildInitialState()
    const result = await persistWizardStreamGovernance(42, state, {})
    expect(result.saved).toBe(true)
    expect(putStreamGovernance).not.toHaveBeenCalled()
  })

  it('persists policy block exactly and keeps unrelated field overrides', async () => {
    fetchStreamGovernance.mockReset()
    putStreamGovernance.mockReset()
    let stored = {
      stream_id: 42,
      enabled: true,
      rules: [],
      route_overrides: [
        {
          field_path: '$.email',
          route_id: 900,
          protection_action: 'mask_full',
          delivery_behavior: 'continue',
          enabled: true,
        },
      ],
    }
    fetchStreamGovernance.mockImplementation(async () => stored)
    putStreamGovernance.mockImplementation(async (_streamId: number, body: typeof stored) => {
      stored = { stream_id: 42, enabled: body.enabled, rules: body.rules, route_overrides: body.route_overrides }
      return stored
    })

    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'block' } },
      },
    ]

    const result = await persistWizardStreamGovernance(42, state, { r1: 900 })
    expect(result.saved).toBe(true)
    expect(result.errors).toEqual([])
    expect(stored.route_overrides).toEqual([
      {
        field_path: '$.email',
        route_id: 900,
        protection_action: 'mask_full',
        delivery_behavior: 'continue',
        enabled: true,
      },
      {
        field_path: null,
        route_id: 900,
        delivery_behavior: 'block',
        enabled: true,
      },
    ])
  })

  it('leaves prior governance intact when PUT fails', async () => {
    fetchStreamGovernance.mockReset()
    putStreamGovernance.mockReset()
    const prior = {
      stream_id: 42,
      enabled: true,
      rules: [],
      route_overrides: [
        { field_path: null, route_id: 900, delivery_behavior: 'quarantine', enabled: true },
      ],
    }
    fetchStreamGovernance.mockResolvedValue(prior)
    putStreamGovernance.mockRejectedValue(new Error('governance unavailable'))

    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'block' } },
      },
    ]
    const result = await persistWizardStreamGovernance(42, state, { r1: 900 })
    expect(result.saved).toBe(false)
    expect(result.errors).toEqual(['governance: governance unavailable'])
    expect(fetchStreamGovernance).toHaveBeenCalledTimes(1)
  })

  it('removes a wizard policy override on inherit without dropping field overrides', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: true },
        governanceLoad: { protection: 'inherited', classification: 'inherited', policy: 'inherited' },
      },
    ]
    const merged = mergeStreamGovernanceDocument(
      {
        enabled: true,
        rules: [{ field_path: '$.email', default_protection_action: 'mask_partial', default_delivery_behavior: 'continue', enabled: true }],
        route_overrides: [
          {
            field_path: '$.email',
            route_id: 900,
            protection_action: 'hash',
            delivery_behavior: 'continue',
            enabled: true,
          },
          { field_path: null, route_id: 900, delivery_behavior: 'block', enabled: true },
        ],
      },
      buildStreamGovernancePayload(state.dataProtection, buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r1: 900 })),
      state.destinations.routeDrafts,
      { r1: 900 },
    )
    expect(merged.rules).toHaveLength(1)
    expect(merged.route_overrides).toEqual([
      {
        field_path: '$.email',
        route_id: 900,
        protection_action: 'hash',
        delivery_behavior: 'continue',
        enabled: true,
      },
    ])
  })

  it('does not move a policy override onto a later route when an earlier route id is missing', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'block' } },
      },
      {
        key: 'r2',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'quarantine' } },
      },
    ]
    const merged = mergeStreamGovernanceDocument(
      { enabled: false, rules: [], route_overrides: [] },
      buildStreamGovernancePayload(state.dataProtection, buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r2: 202 })),
      state.destinations.routeDrafts,
      { r2: 202 },
    )
    expect(merged.route_overrides).toEqual([
      { field_path: null, route_id: 202, delivery_behavior: 'quarantine', enabled: true },
    ])
  })

  it('keeps an unrelated field override when one wizard field override is added', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o-new',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]
    const merged = mergeStreamGovernanceDocument(
      {
        enabled: true,
        rules: [],
        route_overrides: [
          {
            field_path: '$.phone',
            route_id: 800,
            protection_action: 'hash',
            delivery_behavior: 'continue',
            enabled: true,
          },
        ],
      },
      buildStreamGovernancePayload(
        state.dataProtection,
        buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r1: 900 }),
      ),
      state.destinations.routeDrafts,
      { r1: 900 },
    )
    expect(merged.route_overrides).toEqual([
      {
        field_path: '$.phone',
        route_id: 800,
        protection_action: 'hash',
        delivery_behavior: 'continue',
        enabled: true,
      },
      {
        field_path: '$.email',
        route_id: 900,
        protection_action: 'tokenize',
        delivery_behavior: 'continue',
        enabled: true,
      },
    ])
  })

  it('keeps an unrelated governance rule when one wizard rule is added', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i-new',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    const merged = mergeStreamGovernanceDocument(
      {
        enabled: true,
        rules: [
          {
            field_path: '$.phone',
            sensitivity_type: 'pii',
            default_protection_action: 'hash',
            default_delivery_behavior: 'continue',
            enabled: true,
          },
        ],
        route_overrides: [],
      },
      buildStreamGovernancePayload(state.dataProtection, new Map()),
      [],
      {},
    )
    expect(merged.rules).toEqual([
      {
        field_path: '$.phone',
        sensitivity_type: 'pii',
        default_protection_action: 'hash',
        default_delivery_behavior: 'continue',
        enabled: true,
      },
      expect.objectContaining({
        field_path: '$.email',
        default_protection_action: 'mask_partial',
        default_delivery_behavior: 'continue',
      }),
    ])
  })

  it('clears only a wizard-owned policy override and keeps unrelated rules and field overrides', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o-new',
        fieldPath: '$.ssn',
        routeDraftKey: 'r1',
        protectionAction: 'mask_full',
        deliveryBehavior: 'quarantine',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: true },
        governanceLoad: { protection: 'inherited', classification: 'inherited', policy: 'inherited' },
      },
    ]
    const merged = mergeStreamGovernanceDocument(
      {
        enabled: true,
        rules: [
          {
            field_path: '$.phone',
            sensitivity_type: 'pii',
            default_protection_action: 'hash',
            default_delivery_behavior: 'continue',
            enabled: true,
          },
        ],
        route_overrides: [
          {
            field_path: '$.phone',
            route_id: 800,
            protection_action: 'hash',
            delivery_behavior: 'continue',
            enabled: true,
          },
          { field_path: null, route_id: 900, delivery_behavior: 'block', enabled: true },
        ],
      },
      buildStreamGovernancePayload(
        state.dataProtection,
        buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r1: 900 }),
      ),
      state.destinations.routeDrafts,
      { r1: 900 },
    )
    expect(merged.rules.map((rule) => rule.field_path)).toEqual(['$.phone'])
    expect(merged.route_overrides).toEqual([
      {
        field_path: '$.phone',
        route_id: 800,
        protection_action: 'hash',
        delivery_behavior: 'continue',
        enabled: true,
      },
      {
        field_path: '$.ssn',
        route_id: 900,
        protection_action: 'mask_full',
        delivery_behavior: 'quarantine',
        enabled: true,
      },
    ])
  })

  it('replaces one matching field override without dropping an unrelated classification override', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o-edit',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'mask_full',
        deliveryBehavior: 'quarantine',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]
    const merged = mergeStreamGovernanceDocument(
      {
        enabled: true,
        rules: [],
        route_overrides: [
          {
            field_path: '$.email',
            route_id: 900,
            protection_action: 'tokenize',
            delivery_behavior: 'continue',
            enabled: true,
          },
          { route_id: 800, classification_level: 'RESTRICTED', enabled: true },
        ],
      },
      buildStreamGovernancePayload(
        state.dataProtection,
        buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, { r1: 900 }),
      ),
      state.destinations.routeDrafts,
      { r1: 900 },
    )
    expect(merged.route_overrides).toEqual([
      {
        field_path: '$.email',
        route_id: 900,
        protection_action: 'mask_full',
        delivery_behavior: 'quarantine',
        enabled: true,
      },
      { route_id: 800, classification_level: 'RESTRICTED', enabled: true },
    ])
  })
})
