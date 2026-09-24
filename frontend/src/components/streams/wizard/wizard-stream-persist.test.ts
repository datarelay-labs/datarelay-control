import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildInitialState,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  type WizardState,
} from './wizard-state'

const createRoute = vi.fn()
const deleteRoute = vi.fn()
const updateRouteWithFreshToken = vi.fn()
const saveRouteMappingUiConfig = vi.fn()
const saveRouteEnrichmentUiConfig = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const saveStreamMappingUiConfigStrict = vi.fn()
const fetchStreamById = vi.fn()
const updateStream = vi.fn()

vi.mock('../../../api/gdcRoutes', () => ({
  createRoute: (...args: unknown[]) => createRoute(...args),
  deleteRoute: (...args: unknown[]) => deleteRoute(...args),
  updateRouteWithFreshToken: (...args: unknown[]) => updateRouteWithFreshToken(...args),
}))

vi.mock('../../../api/gdcRouteTransform', () => ({
  saveRouteMappingUiConfig: (...args: unknown[]) => saveRouteMappingUiConfig(...args),
  saveRouteEnrichmentUiConfig: (...args: unknown[]) => saveRouteEnrichmentUiConfig(...args),
  fetchRouteTransformEffective: (...args: unknown[]) => fetchRouteTransformEffective(...args),
}))

vi.mock('../../../api/gdcRuntimeUi', () => ({
  saveStreamMappingUiConfigStrict: (...args: unknown[]) => saveStreamMappingUiConfigStrict(...args),
}))

vi.mock('../../../api/gdcStreams', () => ({
  fetchStreamById: (...args: unknown[]) => fetchStreamById(...args),
  updateStream: (...args: unknown[]) => updateStream(...args),
}))

vi.mock('./wizard-data-protection-persist', () => ({
  persistWizardDataProtectionIntents: vi.fn(async () => ({ saved: true, errors: [] })),
}))

vi.mock('./wizard-schema-drift-policy-persist', () => ({
  persistWizardSchemaDriftPolicy: vi.fn(async () => ({ saved: true, errors: [] })),
}))

vi.mock('./wizard-governance-persist', () => ({
  persistWizardStreamGovernance: vi.fn(async () => ({ saved: true, errors: [] })),
}))

vi.mock('../../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionRules: vi.fn(async () => ({
    route_id: 1,
    stream_id: 100,
    protection_enabled: true,
    rules: [],
    rule_count: 0,
  })),
  fetchRouteProtectionEffective: vi.fn(async (routeId: number) => ({
    route_id: routeId,
    stream_id: 100,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })),
  createRouteProtectionRule: vi.fn(async () => ({ rule: { id: 1 } })),
  deleteRouteProtectionRule: vi.fn(async () => undefined),
  patchRouteProtectionRule: vi.fn(),
}))

vi.mock('../../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationRules: vi.fn(async () => ({
    route_id: 1,
    stream_id: 100,
    rules: [],
    rule_count: 0,
  })),
  fetchRouteClassificationEffective: vi.fn(async (routeId: number) => ({
    route_id: routeId,
    stream_id: 100,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })),
  createRouteClassificationRule: vi.fn(async () => ({ rule: { id: 1 } })),
  deleteRouteClassificationRule: vi.fn(async () => undefined),
  patchRouteClassificationRule: vi.fn(),
}))

vi.mock('../../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyRules: vi.fn(async () => ({
    route_id: 1,
    stream_id: 100,
    rules: [],
    rule_count: 0,
  })),
  fetchRoutePolicyEffective: vi.fn(async (routeId: number) => ({
    route_id: routeId,
    stream_id: 100,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
  })),
  createRoutePolicyRule: vi.fn(async () => ({ rule: { id: 1 } })),
  deleteRoutePolicyRule: vi.fn(async () => undefined),
  patchRoutePolicyRule: vi.fn(),
}))

import {
  persistWizardRouteTransformOverrides,
  persistWizardStreamEdits,
  syncRoutes,
  verifyWizardRouteTransformEffective,
} from './wizard-stream-persist'

function editState(mutate: (state: WizardState) => void): WizardState {
  const state = buildInitialState()
  state.connector.connectorId = 1
  state.connector.sourceId = 2
  state.connector.baseUrl = 'https://example.invalid'
  state.mapping = [{ id: 'm1', outputField: 'message', sourceJsonPath: '$.message' }]
  state.outcome = {
    streamId: 100,
    routeId: 11,
    routeIds: [11],
    mappingSaved: true,
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
  }
  mutate(state)
  return state
}

function enrichmentRow(fieldName: string, staticValue: string) {
  return {
    id: `e-${fieldName}`,
    label: fieldName,
    fieldName,
    type: 'static' as const,
    enabled: true,
    staticValue,
    expression: '',
    lookupTable: 'aws-regions',
    lookupKeyField: '',
    conditions: [] as [],
    conditionalDefault: '',
    normalizeSourceField: '',
    normalizeFormat: 'iso8601' as const,
  }
}

describe('wizard-stream-persist route sync + transform', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchStreamById.mockResolvedValue({ id: 100, config_json: {} })
    updateStream.mockResolvedValue({})
    saveStreamMappingUiConfigStrict.mockResolvedValue({})
    saveRouteMappingUiConfig.mockResolvedValue({})
    saveRouteEnrichmentUiConfig.mockResolvedValue({})
    updateRouteWithFreshToken.mockResolvedValue({})
    deleteRoute.mockResolvedValue({})
    fetchRouteTransformEffective.mockImplementation(async (routeId: number) => {
      if (routeId === 22) {
        return {
          route_id: 22,
          stream_id: 100,
          persisted_source: 'mixed',
          mapping_source: 'route',
          enrichment_source: 'stream',
          fallback_used: true,
          mapping_count: 1,
          enrichment_count: 0,
          processing_status: 'Mixed',
          message: 'ok',
        }
      }
      return {
        route_id: routeId,
        stream_id: 100,
        persisted_source: 'stream',
        mapping_source: 'stream',
        enrichment_source: 'stream',
        fallback_used: false,
        mapping_count: 1,
        enrichment_count: 0,
        processing_status: 'Inherited',
        message: 'ok',
      }
    })
  })

  it('captures newly created route ids and applies transform to the new route only', async () => {
    createRoute.mockResolvedValue({ id: 22, stream_id: 100, destination_id: 20 })
    const state = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'route-11',
          destinationId: 10,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
        {
          key: 'wr-new-dest-b',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm2', outputField: 'route_b_msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ]
    })

    const result = await persistWizardStreamEdits(100, state)
    expect(result.ok).toBe(true)
    expect(createRoute).toHaveBeenCalledTimes(1)
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(
      22,
      expect.objectContaining({
        inherit: false,
        mapping: { field_mappings: expect.objectContaining({ route_b_msg: '$.message' }) },
      }),
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(11, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(11, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(22, { inherit: true })
    expect(fetchRouteTransformEffective).toHaveBeenCalledWith(11)
    expect(fetchRouteTransformEffective).toHaveBeenCalledWith(22)
  })

  it('persists enrichment-only route override and clears stale mapping', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [enrichmentRow('tenant', 'acme')],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(20, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        enrichment: expect.objectContaining({
          enabled: true,
          override_policy: 'KEEP_EXISTING',
          enrichment: { tenant: 'acme' },
        }),
      }),
    )
  })

  it('preserves OVERRIDE policy and enabled:false on persist', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [enrichmentRow('tenant', 'acme')],
              enrichmentRowPresent: true,
              enrichmentEnabled: false,
              enrichmentOverridePolicy: 'OVERRIDE',
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(20, {
      inherit: false,
      enrichment: {
        enabled: false,
        enrichment: { tenant: 'acme' },
        override_policy: 'OVERRIDE',
      },
    })
  })

  it('preserves empty enrichment row on mapping+empty-enrichment save', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              enrichmentRowPresent: true,
              enrichmentEnabled: true,
              enrichmentOverridePolicy: 'KEEP_EXISTING',
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(20, {
      inherit: false,
      enrichment: {
        enabled: true,
        enrichment: {},
        override_policy: 'KEEP_EXISTING',
      },
    })
    expect(saveRouteEnrichmentUiConfig).not.toHaveBeenCalledWith(20, { inherit: true })
  })

  it('preserves raw_payload_mode on mapping override save', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              rawPayloadMode: 'include_raw',
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        mapping: expect.objectContaining({
          field_mappings: expect.objectContaining({ msg: '$.message' }),
          raw_payload_mode: 'include_raw',
        }),
      }),
    )
  })

  it('preserves empty mapping row / raw-payload-only on save (no inherit clear)', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              mappingRowPresent: true,
              enrichmentRowPresent: true,
              rawPayloadMode: 'include_raw',
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        mapping: expect.objectContaining({
          field_mappings: {},
          raw_payload_mode: 'include_raw',
        }),
      }),
    )
    expect(saveRouteMappingUiConfig).not.toHaveBeenCalledWith(20, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        enrichment: expect.objectContaining({ enrichment: {} }),
      }),
    )
  })

  it('preserves type-array advanced enrichment on save', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [
                {
                  id: 'e1',
                  label: 'Label',
                  fieldName: 'metadata.label',
                  type: 'calculated',
                  enabled: true,
                  staticValue: '',
                  expression: 'upper({{code}})',
                  lookupTable: 'aws-regions',
                  lookupKeyField: '',
                  conditions: [{ id: 'c1', when: '', then: '' }],
                  conditionalDefault: '',
                  normalizeSourceField: 'timestamp',
                  normalizeFormat: 'iso8601',
                },
              ],
              enrichmentRowPresent: true,
              enrichmentEmitAdvancedAsTypeArray: true,
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        enrichment: expect.objectContaining({
          enrichment: {
            __rules: {
              calculated: [
                expect.objectContaining({
                  target_field: 'metadata.label',
                  expression: 'upper({{code}})',
                }),
              ],
            },
          },
        }),
      }),
    )
  })

  it('clears both Transform subcomponents when switching to inherit global', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(20, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(20, { inherit: true })
  })

  it('mapping-only override clears stale enrichment row', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        mapping: { field_mappings: expect.objectContaining({ msg: '$.message' }) },
      }),
    )
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(20, { inherit: true })
  })

  it('binds Transform persist to draft key when earlier route create failed', async () => {
    await persistWizardRouteTransformOverrides(
      [
        {
          key: 'wr-a',
          destinationId: 10,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
        {
          key: 'wr-b',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm2', outputField: 'route_b_msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      // Positional [22] would wrongly target wr-a; draft-key map targets wr-b only.
      { 'wr-b': 22 },
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(
      22,
      expect.objectContaining({
        inherit: false,
        mapping: { field_mappings: expect.objectContaining({ route_b_msg: '$.message' }) },
      }),
    )
    expect(saveRouteMappingUiConfig).toHaveBeenCalledTimes(1)
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(22, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledTimes(1)
  })

  it('verifies mixed effective status for mapping-only override', async () => {
    const errors = await verifyWizardRouteTransformEffective(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(fetchRouteTransformEffective).toHaveBeenCalledWith(20)
    expect(errors).toEqual([
      'route 20 transform: expected Mixed after save, Effective API returned Inherited',
    ])
  })

  it('verifies overridden effective status for mapping+enrichment override', async () => {
    fetchRouteTransformEffective.mockResolvedValue({
      route_id: 20,
      stream_id: 100,
      persisted_source: 'route',
      mapping_source: 'route',
      enrichment_source: 'route',
      fallback_used: false,
      mapping_count: 1,
      enrichment_count: 1,
      processing_status: 'Overridden',
      message: 'ok',
    })
    const errors = await verifyWizardRouteTransformEffective(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [enrichmentRow('tenant', 'acme')],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'route-20': 20 },
    )
    expect(errors).toEqual([])
  })

  it('fails closed when transform effective read-back mismatches', async () => {
    createRoute.mockResolvedValue({ id: 22, stream_id: 100, destination_id: 20 })
    fetchRouteTransformEffective.mockImplementation(async (routeId: number) => ({
      route_id: routeId,
      stream_id: 100,
      persisted_source: 'stream',
      mapping_source: 'stream',
      enrichment_source: 'stream',
      fallback_used: false,
      mapping_count: 1,
      enrichment_count: 0,
      processing_status: 'Inherited',
      message: 'ok',
    }))
    const state = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'wr-new-dest-b',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm2', outputField: 'route_b_msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ]
      s.outcome = {
        streamId: 100,
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
      }
    })

    const result = await persistWizardStreamEdits(100, state)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('expected Mixed'))).toBe(true)
  })

  it('skips effective verify for incomplete intent-only transform override', async () => {
    const errors = await verifyWizardRouteTransformEffective(
      [
        {
          key: 'route-20',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
        },
      ],
      { 'route-20': 20 },
    )
    expect(fetchRouteTransformEffective).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it('edit-save of hydrated existing Mixed override expects Mixed, not Inherited', async () => {
    fetchRouteTransformEffective.mockResolvedValue({
      route_id: 11,
      stream_id: 100,
      persisted_source: 'mixed',
      mapping_source: 'route',
      enrichment_source: 'stream',
      fallback_used: true,
      mapping_count: 1,
      enrichment_count: 0,
      processing_status: 'Mixed',
      message: 'ok',
    })
    const state = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'route-11',
          destinationId: 10,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          // Hydrated from persisted route mapping override (not DEFAULT inherit).
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'route_msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ]
    })

    const result = await persistWizardStreamEdits(100, state)
    expect(result.ok).toBe(true)
    expect(fetchRouteTransformEffective).toHaveBeenCalledWith(11)
    expect(result.errors).toEqual([])
  })

  it('create/deploy verify fails closed on Effective null', async () => {
    fetchRouteTransformEffective.mockResolvedValue(null)
    const errors = await verifyWizardRouteTransformEffective(
      [
        {
          key: 'wr-new',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'wr-new': 99 },
    )
    expect(errors).toEqual([
      'route 99 transform: Effective API returned no result (expected Mixed)',
    ])
  })

  it('create/deploy verify fails closed on Effective fetch failure', async () => {
    fetchRouteTransformEffective.mockRejectedValue(new Error('network down'))
    const errors = await verifyWizardRouteTransformEffective(
      [
        {
          key: 'wr-new',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: false, protection: true, classification: true, policy: true },
          overrides: {
            transform: {
              mapping: [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message' }],
              mappingMode: 'basic_jsonpath',
              fullEventJsonataExpression: '',
              fullEventRegexConfigJson: '',
              transformRules: [],
              enrichment: [],
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      { 'wr-new': 99 },
    )
    expect(errors).toEqual(['route 99 transform effective: network down'])
  })

  it('syncRoutes returns routeIdsByDraftKey for new drafts', async () => {
    createRoute.mockResolvedValue({ id: 55, stream_id: 100, destination_id: 20 })
    const state = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'wr-temp-1',
          destinationId: 20,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ]
      s.outcome = {
        streamId: 100,
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
      }
    })
    const synced = await syncRoutes(100, state)
    expect(synced.errors).toEqual([])
    expect(synced.routeIdsByDraftKey).toEqual({ 'wr-temp-1': 55 })
  })
})
