import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildInitialState,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  type WizardState,
} from './wizard-state'

const createRoute = vi.fn()
const deleteRoute = vi.fn()
const updateRoute = vi.fn()
const updateRouteWithFreshToken = vi.fn()
const saveRouteMappingUiConfig = vi.fn()
const saveRouteEnrichmentUiConfig = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const saveStreamMappingUiConfigStrict = vi.fn()
const fetchStreamById = vi.fn()
const updateStream = vi.fn()
const fetchStreamPolicyRules = vi.fn()
const fetchStreamClassificationRules = vi.fn()
const fetchStreamProtectionRules = vi.fn()
const fetchStreamGovernance = vi.fn()

vi.mock('../../../api/gdcRoutes', () => ({
  createRoute: (...args: unknown[]) => createRoute(...args),
  deleteRoute: (...args: unknown[]) => deleteRoute(...args),
  updateRoute: (...args: unknown[]) => updateRoute(...args),
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

vi.mock('../../../api/gdcPolicy', () => ({
  fetchStreamPolicyRules: (...args: unknown[]) => fetchStreamPolicyRules(...args),
}))

vi.mock('../../../api/gdcClassification', () => ({
  fetchStreamClassificationRules: (...args: unknown[]) => fetchStreamClassificationRules(...args),
}))

vi.mock('../../../api/gdcProtection', () => ({
  fetchStreamProtectionRules: (...args: unknown[]) => fetchStreamProtectionRules(...args),
}))

vi.mock('../../../api/gdcStreamGovernance', () => ({
  fetchStreamGovernance: (...args: unknown[]) => fetchStreamGovernance(...args),
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
  replaceRouteProtectionRules: vi.fn(async (routeId: number) => ({
    route_id: routeId,
    stream_id: 100,
    protection_enabled: true,
    rules: [],
    rule_count: 0,
  })),
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
  replaceRouteClassificationRules: vi.fn(async (routeId: number) => ({
    route_id: routeId,
    stream_id: 100,
    rules: [],
    rule_count: 0,
  })),
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

import { persistWizardDataProtectionIntents } from './wizard-data-protection-persist'
import { saveStreamMappingUiConfigStrict } from '../../../api/gdcRuntimeUi'
import {
  applyCreatedRouteIdentity,
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
  for (const draft of state.destinations.routeDrafts) {
    if (/^route-\d+$/.test(draft.key) && draft.updatedAt == null) draft.updatedAt = 'route-a'
  }
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
    fetchStreamById.mockResolvedValue({ id: 100, updated_at: 'stream-a', config_json: {} })
    fetchStreamPolicyRules.mockResolvedValue({ rules: [] })
    fetchStreamClassificationRules.mockResolvedValue({ rules: [] })
    fetchStreamProtectionRules.mockResolvedValue({ rules: [] })
    fetchStreamGovernance.mockResolvedValue({ rules: [] })
    updateStream.mockResolvedValue({ id: 100, updated_at: 'stream-b' })
    saveStreamMappingUiConfigStrict.mockResolvedValue({})
    saveRouteMappingUiConfig.mockResolvedValue({})
    saveRouteEnrichmentUiConfig.mockResolvedValue({})
    updateRoute.mockResolvedValue({ id: 5, updated_at: 'route-b' })
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

  it('disables a removed route before deleting it and skips delete when disable fails', async () => {
    const removed = editState((s) => {
      s.outcome = { ...s.outcome!, routeIds: [5] }
      s.destinations.routeDrafts = []
    })
    await syncRoutes(100, removed)
    expect(updateRouteWithFreshToken).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ enabled: false, status: 'DISABLED' }),
    )
    expect(deleteRoute).toHaveBeenCalledWith(5)

    updateRouteWithFreshToken.mockRejectedValueOnce(new Error('stale write'))
    deleteRoute.mockClear()
    const failed = await syncRoutes(100, removed)
    expect(failed.errors[0]).toMatch(/disable route 5/)
    expect(deleteRoute).not.toHaveBeenCalled()
  })

  it('does not delete an existing route when its update fails', async () => {
    updateRoute.mockRejectedValueOnce(new Error('stale write'))
    const state = editState((s) => {
      s.outcome = { ...s.outcome!, routeIds: [5] }
      s.destinations.routeDrafts = [
        {
          key: 'route-5',
          destinationId: 10,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ]
    })
    await syncRoutes(100, state)
    expect(deleteRoute).not.toHaveBeenCalled()
  })

  it('persists two routes to the same destination independently', async () => {
    createRoute.mockResolvedValueOnce({ id: 71, stream_id: 100, destination_id: 7 })
    createRoute.mockResolvedValueOnce({ id: 72, stream_id: 100, destination_id: 7 })
    const state = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'wr-a',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'RETRY_AND_BACKOFF',
          rateLimitJson: { per_minute: 10 },
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
        {
          key: 'wr-b',
          destinationId: 7,
          enabled: false,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: { per_minute: 30 },
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ]
    })
    const synced = await syncRoutes(100, state)
    expect(synced.routeIdsByDraftKey).toEqual({ 'wr-a': 71, 'wr-b': 72 })
    expect(createRoute).toHaveBeenNthCalledWith(1, expect.objectContaining({ failure_policy: 'RETRY_AND_BACKOFF', enabled: true }))
    expect(createRoute).toHaveBeenNthCalledWith(2, expect.objectContaining({ failure_policy: 'LOG_AND_CONTINUE', enabled: false }))
  })

  it('remaps a created route id without replacing newer draft fields', () => {
    const state = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'wr-X',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'RETRY_AND_BACKOFF',
          rateLimitJson: { per_minute: 4 },
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ]
    })
    const next = applyCreatedRouteIdentity(state, { 'wr-X': 55 })
    expect(next.destinations.routeDrafts[0]).toMatchObject({
      key: 'route-55',
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: { per_minute: 4 },
    })
    expect(next.outcome?.routeIds).toContain(55)
    const linked = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'wr-X',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ]
      s.dataProtection.routeOverrides = [
        {
          key: 'ov-1',
          fieldPath: 'email',
          routeDraftKey: 'wr-X',
          protectionAction: 'mask_partial',
          deliveryBehavior: 'continue',
          enabled: true,
        },
      ]
    })
    const remapped = applyCreatedRouteIdentity(linked, { 'wr-X': 55 })
    expect(remapped.dataProtection.routeOverrides[0]?.routeDraftKey).toBe('route-55')
    expect(remapped.dataProtection.routeClassificationOverrides).toEqual([])
    const classified = editState((s) => {
      s.destinations.routeDrafts = [
        {
          key: 'wr-a',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
        {
          key: 'wr-b',
          destinationId: 8,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        },
      ]
      s.dataProtection.routeClassificationOverrides = [
        { key: 'c1', routeDraftKey: 'wr-a', classificationLevel: 'INTERNAL', enabled: true },
        { key: 'c2', routeDraftKey: 'wr-b', classificationLevel: 'RESTRICTED', enabled: true },
      ]
    })
    const both = applyCreatedRouteIdentity(classified, { 'wr-a': 71, 'wr-b': 72 })
    expect(both.dataProtection.routeClassificationOverrides.map((row) => row.routeDraftKey)).toEqual(['route-71', 'route-72'])
    expect(both.dataProtection.routeClassificationOverrides.map((row) => row.classificationLevel)).toEqual(['INTERNAL', 'RESTRICTED'])
  })

  it('merges wizard prefix edits into the hydrated formatter and uses the route token', async () => {
    const state = editState((s) => {
      s.outcome = { ...s.outcome!, routeIds: [5, 6] }
      s.destinations.routeDrafts = [
        {
          key: 'route-5',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
          updatedAt: 'token-5',
          formatterConfig: { message_format: 'json', delivery_mode: 'batch', vendor_key: 'keep' },
          messagePrefixEnabled: true,
          messagePrefixTemplate: 'prefix-a',
        },
        {
          key: 'route-6',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
          updatedAt: 'token-6',
          formatterConfig: { message_format: 'text', delivery_mode: 'single', vendor_key: 'other' },
          messagePrefixEnabled: false,
          messagePrefixTemplate: 'prefix-b',
        },
      ]
    })
    await syncRoutes(100, state)
    expect(updateRouteWithFreshToken).not.toHaveBeenCalled()
    expect(updateRoute).toHaveBeenNthCalledWith(
      1,
      5,
      expect.objectContaining({
        expected_updated_at: 'token-5',
        formatter_config_json: expect.objectContaining({
          message_format: 'json',
          delivery_mode: 'batch',
          vendor_key: 'keep',
          message_prefix_template: 'prefix-a',
          message_prefix_enabled: true,
        }),
      }),
    )
    expect(updateRoute).toHaveBeenNthCalledWith(
      2,
      6,
      expect.objectContaining({
        expected_updated_at: 'token-6',
        formatter_config_json: expect.objectContaining({
          message_format: 'text',
          message_prefix_template: 'prefix-b',
          message_prefix_enabled: false,
        }),
      }),
    )
  })

  it('does not confirm a mapping clear or create duplicate data-protection rules for an unchanged intent', async () => {
    const confirmed = editState((s) => {
      s.mapping = [{ id: 'm1', outputField: 'message', sourceJsonPath: '$.message' }]
      s.dataProtection.intents = [
        {
          id: 'intent-1',
          detectedField: 'email',
          sensitivityClass: 'pii',
          protectionAction: 'mask_partial',
          deliveryBehavior: 'deliver',
          enabled: true,
        } as never,
      ]
    })
    const cleared = editState((s) => {
      s.mapping = []
      s.dataProtection = confirmed.dataProtection
    })
    const clearResult = await persistWizardStreamEdits(100, cleared, { confirmedState: confirmed })
    expect(clearResult.ok).toBe(false)
    expect(clearResult.errors.join(' ')).toMatch(/not supported/)
    expect(saveStreamMappingUiConfigStrict).not.toHaveBeenCalled()

    const renamed = editState((s) => {
      s.stream.name = 'Renamed'
      s.mapping = confirmed.mapping
      s.dataProtection = confirmed.dataProtection
    })
    vi.mocked(persistWizardDataProtectionIntents).mockClear()
    const sameIntent = await persistWizardStreamEdits(100, renamed, { confirmedState: confirmed })
    expect(sameIntent.ok).toBe(true)
    expect(persistWizardDataProtectionIntents).not.toHaveBeenCalled()
  })

  it('does not create Data Protection rules when the server already has policy rows', async () => {
    fetchStreamPolicyRules.mockResolvedValue({ rules: [{ id: 1 }] })
    const confirmed = editState((s) => {
      s.dataProtection.intents = []
    })
    const added = editState((s) => {
      s.stream.name = 'Renamed'
      s.dataProtection.intents = [
        { key: 'intent-1', detectedField: 'email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
      ]
    })
    const result = await persistWizardStreamEdits(100, added, { confirmedState: confirmed })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/already present/)
    expect(persistWizardDataProtectionIntents).not.toHaveBeenCalled()
  })

  it('sends the same stream token used to merge config and fails closed on 409', async () => {
    let reads = 0
    fetchStreamById.mockImplementation(async () => {
      reads += 1
      return {
        id: 100,
        updated_at: reads === 1 ? 'stream-a' : 'stream-external',
        config_json: { sentinel: true },
        rate_limit_json: { max_events: 120, per_seconds: 60, vendor_limit: 'keep' },
      }
    })
    const state = editState((s) => {
      s.stream.name = 'Renamed'
      s.stream.rateLimitPerMinute = 30
      s.stream.rateLimitUnknownKeys = { vendor_limit: 'keep' }
    })
    const saved = await persistWizardStreamEdits(100, state, { confirmedState: editState(() => undefined) })
    expect(saved.ok).toBe(true)
    expect(fetchStreamById).toHaveBeenCalledTimes(1)
    const payload = updateStream.mock.calls.at(-1)?.[1] as {
      expected_updated_at: string
      config_json: Record<string, unknown>
      rate_limit_json: Record<string, unknown>
    }
    expect(payload.expected_updated_at).toBe('stream-a')
    expect(payload.config_json.sentinel).toBe(true)
    expect(payload.rate_limit_json).toEqual({ vendor_limit: 'keep', max_events: 30, per_seconds: 60 })

    updateStream.mockRejectedValueOnce(new Error('STREAM_STALE_WRITE'))
    const stale = await persistWizardStreamEdits(100, state, { confirmedState: editState(() => undefined) })
    expect(stale.ok).toBe(false)
    expect(stale.streamUpdatedAt).toBeNull()
    expect(stale.errors.join(' ')).toMatch(/STREAM_STALE_WRITE/)
  })

  it('refuses a broad route update that has no hydrated concurrency token', async () => {
    const state = editState((s) => {
      s.outcome = { ...s.outcome!, routeIds: [5] }
      s.destinations.routeDrafts = [
        {
          key: 'route-5',
          destinationId: 7,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
          updatedAt: '',
        },
      ]
    })
    const synced = await syncRoutes(100, state)
    expect(updateRoute).not.toHaveBeenCalled()
    expect(updateRouteWithFreshToken).not.toHaveBeenCalled()
    expect(synced.errors[0]).toMatch(/concurrency token/)
  })

  it('advances Data Protection after a later concern fails, and blocks create when the preflight read fails', async () => {
    const { persistWizardStreamGovernance } = await import('./wizard-governance-persist')
    vi.mocked(persistWizardStreamGovernance).mockResolvedValueOnce({ saved: false, errors: ['governance failed'] })
    const confirmed = editState((s) => {
      s.dataProtection.intents = []
    })
    const added = editState((s) => {
      s.dataProtection.intents = [
        { key: 'intent-1', detectedField: 'email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
      ]
    })
    vi.mocked(persistWizardDataProtectionIntents).mockClear()
    const partial = await persistWizardStreamEdits(100, added, { confirmedState: confirmed })
    expect(partial.ok).toBe(false)
    expect(partial.dataProtectionPersisted).toBe(true)
    expect(persistWizardDataProtectionIntents).toHaveBeenCalledTimes(1)

    fetchStreamClassificationRules.mockResolvedValueOnce(null)
    vi.mocked(persistWizardDataProtectionIntents).mockClear()
    const unreadable = await persistWizardStreamEdits(100, added, { confirmedState: confirmed })
    expect(unreadable.dataProtectionPersisted).toBe(false)
    expect(unreadable.errors.join(' ')).toMatch(/could not be read/)
    expect(persistWizardDataProtectionIntents).not.toHaveBeenCalled()
  })

  it('removes an explicitly cleared checkpoint and keeps an untouched checkpoint on rename', async () => {
    fetchStreamById.mockResolvedValue({
      id: 100,
      updated_at: 'stream-a',
      config_json: {
        checkpoint: { mode: 'Cursor', cursor_path: '$.id', secondary_cursor_path: '$.seq', vendor_cursor: 'keep' },
        remote_directory: '/incoming',
      },
    })
    const confirmed = editState((s) => {
      s.connector.sourceType = 'REMOTE_FILE_POLLING'
      s.stream.checkpointSourcePath = '$.id'
      s.stream.checkpointSecondaryPath = '$.seq'
      s.stream.remoteDirectory = '/incoming'
      s.stream.filePattern = '*.ndjson'
    })
    const cleared = editState((s) => {
      s.connector.sourceType = 'REMOTE_FILE_POLLING'
      s.stream.checkpointSourcePath = ''
      s.stream.checkpointSecondaryPath = ''
      s.stream.remoteDirectory = '/incoming'
      s.stream.filePattern = '*.ndjson'
    })
    await persistWizardStreamEdits(100, cleared, { confirmedState: confirmed })
    const clearedPayload = updateStream.mock.calls.at(-1)?.[1] as { config_json: Record<string, unknown> }
    expect(clearedPayload.config_json).not.toHaveProperty('checkpoint')
    expect(clearedPayload.config_json.remote_directory).toBe('/incoming')
    expect(clearedPayload.config_json.file_pattern).toBe('*.ndjson')

    const renamed = editState((s) => {
      s.stream.name = 'Renamed only'
      s.connector.sourceType = 'REMOTE_FILE_POLLING'
      s.stream.checkpointSourcePath = '$.id'
      s.stream.checkpointSecondaryPath = '$.seq'
      s.stream.remoteDirectory = '/incoming'
      s.stream.filePattern = '*.ndjson'
    })
    await persistWizardStreamEdits(100, renamed, { confirmedState: confirmed })
    const renamedPayload = updateStream.mock.calls.at(-1)?.[1] as { config_json: Record<string, unknown> }
    expect(renamedPayload.config_json.checkpoint).toMatchObject({
      cursor_path: '$.id',
      secondary_cursor_path: '$.seq',
      vendor_cursor: 'keep',
    })
  })

  it('keeps disabled enrichment metadata and passthrough when the rules do not change', async () => {
    const confirmed = editState((s) => {
      s.enrichment = [enrichmentRow('host', 'acme')]
      s.enrichmentEnabled = false
      s.enrichmentOverridePolicy = 'OVERRIDE'
      s.enrichmentPassthrough = { vendor_fragment: { keep: true } }
    })
    const renamed = editState((s) => {
      s.stream.name = 'Renamed'
      s.enrichment = confirmed.enrichment
      s.enrichmentEnabled = false
      s.enrichmentOverridePolicy = 'OVERRIDE'
      s.enrichmentPassthrough = { vendor_fragment: { keep: true } }
    })
    await persistWizardStreamEdits(100, renamed, { confirmedState: confirmed })
    const unchanged = saveStreamMappingUiConfigStrict.mock.calls.at(-1)?.[1] as { enrichment: unknown }
    expect(unchanged.enrichment).toBeNull()
    saveStreamMappingUiConfigStrict.mockClear()

    const added = editState((s) => {
      s.enrichment = [...confirmed.enrichment, enrichmentRow('env', 'prod')]
      s.enrichmentEnabled = false
      s.enrichmentOverridePolicy = 'ERROR_ON_CONFLICT'
      s.enrichmentPassthrough = { vendor_fragment: { keep: true } }
    })
    await persistWizardStreamEdits(100, added, { confirmedState: confirmed })
    const mappingPayload = saveStreamMappingUiConfigStrict.mock.calls.at(-1)?.[1] as {
      enrichment: { enabled: boolean; override_policy: string; enrichment: Record<string, unknown> }
    }
    expect(mappingPayload.enrichment.enabled).toBe(false)
    expect(mappingPayload.enrichment.override_policy).toBe('ERROR_ON_CONFLICT')
    expect(mappingPayload.enrichment.enrichment.__rules).toMatchObject({ vendor_fragment: { keep: true } })
  })

  it('removes a cleared config event path and does not confirm a mapping-only clear', async () => {
    fetchStreamById.mockResolvedValue({
      id: 100,
      updated_at: 'stream-a',
      config_json: { event_array_path: '$.items', vendor: 1 },
    })
    const confirmed = editState((s) => {
      s.stream.eventArrayPath = 'items'
      s.mapping = []
    })
    const cleared = editState((s) => {
      s.stream.eventArrayPath = ''
      s.mapping = []
    })
    const removed = await persistWizardStreamEdits(100, cleared, { confirmedState: confirmed })
    expect(removed.ok).toBe(true)
    const removedPayload = updateStream.mock.calls.at(-1)?.[1] as { config_json: Record<string, unknown> }
    expect(removedPayload.config_json).not.toHaveProperty('event_array_path')
    expect(removedPayload.config_json.vendor).toBe(1)

    fetchStreamById.mockResolvedValue({ id: 100, updated_at: 'stream-a', config_json: { vendor: 1 } })
    const mappingOnly = await persistWizardStreamEdits(100, cleared, { confirmedState: confirmed })
    expect(mappingOnly.ok).toBe(false)
    expect(mappingOnly.errors.join(' ')).toMatch(/extraction path/)
  })
})
