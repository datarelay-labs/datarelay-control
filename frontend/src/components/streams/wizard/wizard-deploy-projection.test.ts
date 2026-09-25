import { describe, expect, it } from 'vitest'
import {
  accumulateRouteProcessingProjectedCounts,
  deployIntentPersistLabel,
  projectRouteProcessingStatusFromDeployIntent,
} from './wizard-deploy-projection'
import { buildInitialState } from './wizard-state'

function baseDraft(
  key: string,
  inherit?: Partial<{ transform: boolean; protection: boolean; classification: boolean; policy: boolean }>,
  overrides?: {
    transform?: {
      mapping: Array<{ id: string; outputField: string; sourceJsonPath: string }>
      enrichment?: Array<{
        id: string
        label: string
        fieldName: string
        type: 'static'
        enabled: boolean
        staticValue: string
        expression: string
        lookupTable: string
        lookupKeyField: string
        conditions: []
        conditionalDefault: string
        normalizeSourceField: string
        normalizeFormat: 'iso8601'
      }>
    }
  },
) {
  return {
    key,
    destinationId: 10,
    enabled: true,
    failurePolicy: 'LOG_AND_CONTINUE' as const,
    rateLimitJson: {},
    inherit: {
      transform: true,
      protection: true,
      classification: true,
      policy: true,
      ...inherit,
    },
    overrides: overrides
      ? {
          transform: overrides.transform
            ? {
                mapping: overrides.transform.mapping,
                mappingMode: 'basic_jsonpath' as const,
                fullEventJsonataExpression: '',
                fullEventRegexConfigJson: '',
                transformRules: [],
                enrichment: overrides.transform.enrichment ?? [],
                unmappedFieldsPolicy: 'pass_through' as const,
              }
            : undefined,
        }
      : undefined,
  }
}

describe('projectRouteProcessingStatusFromDeployIntent', () => {
  it('returns Inherited statuses for default inherit flags', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(baseDraft('r1'), state.dataProtection)
    expect(projection.statuses).toEqual({
      transform: 'Inherited',
      protection: 'Inherited',
      classification: 'Inherited',
      policy: 'Inherited',
    })
    expect(projection.concerns.transform.persistKind).toBe('none')
  })

  it('marks empty transform override as intent only', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      baseDraft('r1', { transform: false }),
      state.dataProtection,
    )
    expect(projection.statuses.transform).toBe('Overridden')
    expect(projection.concerns.transform.persistKind).toBe('intent_only')
    expect(deployIntentPersistLabel(projection.concerns.transform.persistKind)).toBe('Intent only')
  })

  it('marks complete transform override as route_transform persist', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      baseDraft(
        'r1',
        { transform: false },
        {
          transform: {
            mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
            enrichment: [
              {
                id: 'e1',
                label: 'Tenant',
                fieldName: 'tenant',
                type: 'static',
                enabled: true,
                staticValue: 'acme',
                expression: '',
                lookupTable: 'aws-regions',
                lookupKeyField: '',
                conditions: [],
                conditionalDefault: '',
                normalizeSourceField: '',
                normalizeFormat: 'iso8601',
              },
            ],
          },
        },
      ),
      state.dataProtection,
    )
    expect(projection.statuses.transform).toBe('Overridden')
    expect(projection.concerns.transform.persistKind).toBe('route_transform')
    expect(deployIntentPersistLabel(projection.concerns.transform.persistKind)).toBe(
      'Persisted as route Transform',
    )
  })

  it('marks mapping-only transform override as Mixed with route_transform persist', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      baseDraft(
        'r1',
        { transform: false },
        {
          transform: {
            mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
          },
        },
      ),
      state.dataProtection,
    )
    expect(projection.statuses.transform).toBe('Mixed')
    expect(projection.concerns.transform.persistKind).toBe('route_transform')
  })

  it('preserves Mixed status for protection when inherit off and field overrides exist', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        routeDraftKey: 'r1',
        fieldPath: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    const projection = projectRouteProcessingStatusFromDeployIntent(
      baseDraft('r1', { protection: false }),
      state.dataProtection,
    )
    expect(projection.statuses.protection).toBe('Mixed')
    expect(projection.concerns.protection.persistKind).toBe('intent_only')
  })

  it('marks a complete protection bundle as route_protection persist', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      {
        ...baseDraft('r1', { protection: false }),
        overrides: {
          protection: {
            intents: [
              {
                key: 'i1',
                detectedField: '$.email',
                protectionAction: 'mask_partial',
                deliveryBehavior: 'continue',
              },
            ],
            unknownNormalFieldPolicy: 'pass_through',
            unknownSensitiveFieldPolicy: 'auto_protect',
          },
        },
      },
      state.dataProtection,
    )
    expect(projection.statuses.protection).toBe('Overridden')
    expect(projection.concerns.protection.persistKind).toBe('route_protection')
    expect(deployIntentPersistLabel(projection.concerns.protection.persistKind)).toBe(
      'Persisted as route Protection',
    )
  })

  it('marks classification derived from route protection intents as route_classification persist', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      {
        ...baseDraft('r1', { classification: false }),
        overrides: {
          protection: {
            intents: [
              {
                key: 'i1',
                detectedField: '$.email',
                protectionAction: 'mask_full',
                deliveryBehavior: 'continue',
              },
            ],
            unknownNormalFieldPolicy: 'pass_through',
            unknownSensitiveFieldPolicy: 'auto_protect',
          },
        },
      },
      state.dataProtection,
    )
    expect(projection.statuses.classification).toBe('Overridden')
    expect(projection.concerns.classification.persistKind).toBe('route_classification')
  })

  it('marks an explicit route delivery behavior as route_policy persist', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      {
        ...baseDraft('r1', { policy: false }),
        overrides: { policy: { deliveryBehavior: 'quarantine' } },
      },
      state.dataProtection,
    )
    expect(projection.statuses.policy).toBe('Overridden')
    expect(projection.concerns.policy.persistKind).toBe('route_policy')
    expect(deployIntentPersistLabel(projection.concerns.policy.persistKind)).toBe('Persisted as route Policy')
  })

  it('keeps an empty policy override as intent only', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      baseDraft('r1', { policy: false }),
      state.dataProtection,
    )
    expect(projection.statuses.policy).toBe('Overridden')
    expect(projection.concerns.policy.persistKind).toBe('intent_only')
  })

  it('marks governance field protection override when inherit shared', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        routeDraftKey: 'r1',
        fieldPath: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    const projection = projectRouteProcessingStatusFromDeployIntent(baseDraft('r1'), state.dataProtection)
    expect(projection.statuses.protection).toBe('Overridden')
    expect(projection.concerns.protection.persistKind).toBe('governance')
    expect(deployIntentPersistLabel(projection.concerns.protection.persistKind)).toBe(
      'Persisted through governance rules',
    )
  })

  it('accumulates override and mixed counts separately', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      baseDraft('r1', { transform: false }),
      baseDraft('r2', { protection: false }),
    ]
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        routeDraftKey: 'r2',
        fieldPath: '$.secret',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    const counts = accumulateRouteProcessingProjectedCounts(state.destinations.routeDrafts, state.dataProtection)
    expect(counts.transform).toEqual({ override: 1, mixed: 0 })
    expect(counts.protection).toEqual({ override: 0, mixed: 1 })
    expect(counts.classification).toEqual({ override: 0, mixed: 0 })
    expect(counts.policy).toEqual({ override: 0, mixed: 0 })
  })
})
