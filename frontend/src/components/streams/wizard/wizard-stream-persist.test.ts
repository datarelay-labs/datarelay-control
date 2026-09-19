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

import { persistWizardRouteTransformOverrides, persistWizardStreamEdits, syncRoutes } from './wizard-stream-persist'

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
    expect(saveRouteMappingUiConfig).not.toHaveBeenCalledWith(11, expect.anything())
  })

  it('persists enrichment-only route override via enrichment API', async () => {
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
              unmappedFieldsPolicy: 'pass_through',
            },
          },
        },
      ],
      [20],
    )
    expect(saveRouteMappingUiConfig).not.toHaveBeenCalled()
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        inherit: false,
        enrichment: expect.objectContaining({
          enrichment: { tenant: 'acme' },
        }),
      }),
    )
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
