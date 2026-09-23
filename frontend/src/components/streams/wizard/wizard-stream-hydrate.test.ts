import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyRouteTransformConfigsToDraft,
  buildWizardDestinationsFromRouteSources,
  fullEventJsonataExpressionFromFieldMappings,
  hydrateRouteDraftsTransform,
  tryApplyRouteTransformConfigsToDraft,
} from './wizard-stream-hydrate'
import type { MappingUIConfigRouteItem } from '../../../api/types/gdcApi'
import type { RouteRead } from '../../../api/gdcRoutes'
import type { RouteEnrichmentUiConfig, RouteMappingUiConfig } from '../../../api/gdcRouteTransform'
import { buildRouteTransformPersistPlans, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'

const fetchRouteMappingUiConfig = vi.fn()
const fetchRouteEnrichmentUiConfig = vi.fn()

vi.mock('../../../api/gdcRouteTransform', () => ({
  fetchRouteMappingUiConfig: (...args: unknown[]) => fetchRouteMappingUiConfig(...args),
  fetchRouteEnrichmentUiConfig: (...args: unknown[]) => fetchRouteEnrichmentUiConfig(...args),
}))

describe('fullEventJsonataExpressionFromFieldMappings', () => {
  it('reads jsonata_expression for full_event_jsonata mappings', () => {
    expect(
      fullEventJsonataExpressionFromFieldMappings({
        mapping_mode: 'full_event_jsonata',
        jsonata_expression: '$merge([$, { "host": hostname }])',
      }),
    ).toBe('$merge([$, { "host": hostname }])')
  })

  it('falls back to legacy expression key when jsonata_expression is absent', () => {
    expect(
      fullEventJsonataExpressionFromFieldMappings({
        mapping_mode: 'full_event_jsonata',
        expression: '{ "id": id }',
      }),
    ).toBe('{ "id": id }')
  })

  it('returns empty string for non-jsonata mapping modes', () => {
    expect(
      fullEventJsonataExpressionFromFieldMappings({
        mapping_mode: 'basic_jsonpath',
        jsonata_expression: 'ignored',
      }),
    ).toBe('')
  })
})

describe('tryApplyRouteTransformConfigsToDraft fail-closed reads', () => {
  const baseDraft = {
    key: 'route-42',
    destinationId: 7,
    enabled: true,
    failurePolicy: 'LOG_AND_CONTINUE' as const,
    rateLimitJson: {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
  }

  const inheritedMapping: RouteMappingUiConfig = {
    route_id: 42,
    stream_id: 10,
    inherit_stream_mapping: true,
    mapping: {
      exists: false,
      event_array_path: null,
      event_root_path: null,
      field_mappings: {},
      raw_payload_mode: null,
    },
    stream_mapping: {
      exists: true,
      event_array_path: null,
      event_root_path: null,
      field_mappings: { msg: '$.message' },
      raw_payload_mode: null,
    },
    message: 'ok',
  }

  const overrideMapping: RouteMappingUiConfig = {
    route_id: 42,
    stream_id: 10,
    inherit_stream_mapping: false,
    mapping: {
      exists: true,
      event_array_path: null,
      event_root_path: null,
      field_mappings: { route_msg: '$.message' },
      raw_payload_mode: null,
    },
    stream_mapping: {
      exists: true,
      event_array_path: null,
      event_root_path: null,
      field_mappings: {},
      raw_payload_mode: null,
    },
    message: 'ok',
  }

  const inheritedEnrichment: RouteEnrichmentUiConfig = {
    route_id: 42,
    stream_id: 10,
    inherit_stream_enrichment: true,
    enrichment: {
      exists: false,
      enabled: false,
      enrichment: {},
      override_policy: null,
    },
    stream_enrichment: {
      exists: true,
      enabled: true,
      enrichment: { tenant: 'acme' },
      override_policy: null,
    },
    message: 'ok',
  }

  it('fails closed when mapping config read returns null', () => {
    const result = tryApplyRouteTransformConfigsToDraft(baseDraft, null, inheritedEnrichment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/mapping config read failed/)
    expect(result.error).toMatch(/refusing to default to Inherited/)
  })

  it('fails closed when enrichment config read returns null', () => {
    const result = tryApplyRouteTransformConfigsToDraft(baseDraft, overrideMapping, null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/enrichment config read failed/)
  })

  it('does not return an Inherited draft from a failed read that would clear overrides', () => {
    const result = tryApplyRouteTransformConfigsToDraft(baseDraft, null, null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/refusing to default to Inherited/)
    // Failed apply must not yield a draft usable for inherit:true clear plans.
    expect('draft' in result).toBe(false)
  })

  it('applies genuine inherited configs when both reads succeed', () => {
    const result = tryApplyRouteTransformConfigsToDraft(baseDraft, inheritedMapping, inheritedEnrichment)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.inherit.transform).toBe(true)
  })
})

describe('hydrateRouteDraftsTransform', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails closed when safeRequestJson-null mapping read would otherwise coerce to Inherited', async () => {
    fetchRouteMappingUiConfig.mockResolvedValue(null)
    fetchRouteEnrichmentUiConfig.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: true,
      enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      stream_enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      message: 'ok',
    })

    const result = await hydrateRouteDraftsTransform([
      {
        key: 'route-42',
        destinationId: 7,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/mapping config read failed/)
    // No drafts returned for save — cannot clear persisted overrides.
    expect('drafts' in result).toBe(false)
  })

  it('hydrates mapping-only override when both config reads succeed', async () => {
    fetchRouteMappingUiConfig.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      inherit_stream_mapping: false,
      mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: { route_msg: '$.message' },
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {},
        raw_payload_mode: null,
      },
      message: 'ok',
    })
    fetchRouteEnrichmentUiConfig.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: true,
      enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      stream_enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      message: 'ok',
    })

    const result = await hydrateRouteDraftsTransform([
      {
        key: 'route-42',
        destinationId: 7,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drafts[0]?.inherit.transform).toBe(false)
    expect(result.drafts[0]?.overrides?.transform?.mapping).toEqual([
      expect.objectContaining({ outputField: 'route_msg', sourceJsonPath: '$.message' }),
    ])
    const plans = buildRouteTransformPersistPlans(result.drafts, { 'route-42': 42 })
    expect(plans[0]?.mapping).toEqual({
      inherit: false,
      fieldMappings: expect.objectContaining({ route_msg: '$.message' }),
    })
    expect(plans[0]?.enrichment).toEqual({ inherit: true })
  })
})

describe('applyRouteTransformConfigsToDraft', () => {
  const baseDraft = {
    key: 'route-42',
    destinationId: 7,
    enabled: true,
    failurePolicy: 'LOG_AND_CONTINUE' as const,
    rateLimitJson: {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
  }

  it('keeps transform inherited when both mapping and enrichment inherit stream', () => {
    const mappingCfg: RouteMappingUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_mapping: true,
      mapping: {
        exists: false,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {},
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: { msg: '$.message' },
        raw_payload_mode: null,
      },
      message: 'ok',
    }
    const enrichmentCfg: RouteEnrichmentUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: true,
      enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      stream_enrichment: {
        exists: true,
        enabled: true,
        enrichment: { tenant: 'acme' },
        override_policy: null,
      },
      message: 'ok',
    }
    const next = applyRouteTransformConfigsToDraft(baseDraft, mappingCfg, enrichmentCfg)
    expect(next.inherit.transform).toBe(true)
    expect(next.overrides?.transform).toBeUndefined()
  })

  it('hydrates mapping-only Mixed override for truthful edit-save expectation', () => {
    const mappingCfg: RouteMappingUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_mapping: false,
      mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: { route_msg: '$.message' },
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {},
        raw_payload_mode: null,
      },
      message: 'ok',
    }
    const enrichmentCfg: RouteEnrichmentUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: true,
      enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      stream_enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      message: 'ok',
    }
    const next = applyRouteTransformConfigsToDraft(baseDraft, mappingCfg, enrichmentCfg)
    expect(next.inherit.transform).toBe(false)
    expect(next.overrides?.transform?.mapping).toEqual([
      expect.objectContaining({ outputField: 'route_msg', sourceJsonPath: '$.message' }),
    ])
    expect(next.overrides?.transform?.enrichment).toEqual([])
  })

  it('hydrates enrichment-only Mixed override', () => {
    const mappingCfg: RouteMappingUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_mapping: true,
      mapping: {
        exists: false,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {},
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: false,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {},
        raw_payload_mode: null,
      },
      message: 'ok',
    }
    const enrichmentCfg: RouteEnrichmentUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: false,
      enrichment: {
        exists: true,
        enabled: true,
        enrichment: { tenant: 'acme' },
        override_policy: 'KEEP_EXISTING',
      },
      stream_enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      message: 'ok',
    }
    const next = applyRouteTransformConfigsToDraft(baseDraft, mappingCfg, enrichmentCfg)
    expect(next.inherit.transform).toBe(false)
    expect(next.overrides?.transform?.mapping).toEqual([])
    expect(next.overrides?.transform?.enrichment).toEqual([
      expect.objectContaining({ fieldName: 'tenant', staticValue: 'acme' }),
    ])
  })

  it('hydrates full-event Regex mapping so unrelated save does not clear it', () => {
    const mappingCfg: RouteMappingUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_mapping: false,
      mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {
          mapping_mode: 'full_event_regex',
          preserve_source_fields: false,
          regex_rules: [
            {
              output_field: 'user',
              source_path: '$.username',
              pattern: '^(.+)$',
              capture_group: 1,
              default_value: null,
            },
          ],
        },
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: false,
        event_array_path: null,
        event_root_path: null,
        field_mappings: {},
        raw_payload_mode: null,
      },
      message: 'ok',
    }
    const enrichmentCfg: RouteEnrichmentUiConfig = {
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: false,
      enrichment: {
        exists: true,
        enabled: true,
        enrichment: { tenant: 'acme' },
        override_policy: 'KEEP_EXISTING',
      },
      stream_enrichment: {
        exists: false,
        enabled: false,
        enrichment: {},
        override_policy: null,
      },
      message: 'ok',
    }

    const next = applyRouteTransformConfigsToDraft(baseDraft, mappingCfg, enrichmentCfg)
    expect(next.inherit.transform).toBe(false)
    expect(next.overrides?.transform?.mappingMode).toBe('full_event_regex')
    expect(next.overrides?.transform?.fullEventRegexConfigJson).toContain('"pattern": "^(.+)$"')
    expect(next.overrides?.transform?.fullEventRegexConfigJson).toContain('"preserve_source": false')

    const plans = buildRouteTransformPersistPlans([next], { 'route-42': 42 })
    expect(plans).toHaveLength(1)
    expect(plans[0]?.mapping).toEqual({
      inherit: false,
      fieldMappings: expect.objectContaining({
        mapping_mode: 'full_event_regex',
        preserve_source_fields: false,
        regex_rules: expect.any(Array),
      }),
    })
    expect(plans[0]?.enrichment).toEqual({
      inherit: false,
      enrichment: { tenant: 'acme' },
    })
  })
})

describe('buildWizardDestinationsFromRouteSources', () => {
  it('prefers mapping-ui routes when both sources include the same route', () => {
    const mappingRoutes: MappingUIConfigRouteItem[] = [
      {
        route_id: 42,
        destination_id: 7,
        destination_name: 'Webhook A',
        destination_type: 'WEBHOOK_POST',
        route_enabled: true,
        destination_enabled: true,
        formatter_config: { message_prefix_enabled: true, message_prefix_template: 'custom-prefix' },
        route_rate_limit: { per_minute: 30 },
        failure_policy: 'RETRY_AND_BACKOFF',
      },
    ]
    const catalogRoutes: RouteRead[] = [
      {
        id: 42,
        stream_id: 10,
        destination_id: 7,
        enabled: false,
        failure_policy: 'LOG_AND_CONTINUE',
      },
    ]

    const result = buildWizardDestinationsFromRouteSources(mappingRoutes, catalogRoutes, [
      { id: 7, destination_type: 'WEBHOOK_POST' },
    ])

    expect(result.routeDrafts).toHaveLength(1)
    expect(result.routeDrafts[0]).toMatchObject({
      key: 'route-42',
      destinationId: 7,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
    })
    expect(result.messagePrefixTemplate).toBe('custom-prefix')
  })

  it('falls back to catalog routes when mapping-ui routes are empty', () => {
    const catalogRoutes: RouteRead[] = [
      {
        id: 99,
        stream_id: 10,
        destination_id: 3,
        enabled: true,
        failure_policy: 'LOG_AND_CONTINUE',
        formatter_config_json: {
          message_prefix_enabled: false,
          message_prefix_template: 'from-catalog',
        },
      },
    ]

    const result = buildWizardDestinationsFromRouteSources([], catalogRoutes, [
      { id: 3, destination_type: 'SYSLOG_UDP' },
    ])

    expect(result.routeDrafts).toEqual([
      expect.objectContaining({
        key: 'route-99',
        destinationId: 3,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
      }),
    ])
    expect(result.destinationKindsById[3]).toBe('SYSLOG_UDP')
    expect(result.messagePrefixEnabledByDestinationId[3]).toBe(false)
    expect(result.messagePrefixTemplate).toBe('from-catalog')
  })

  it('merges mapping-ui and catalog-only routes without duplicates', () => {
    const mappingRoutes: MappingUIConfigRouteItem[] = [
      {
        route_id: 1,
        destination_id: 5,
        destination_name: 'A',
        destination_type: 'WEBHOOK_POST',
        route_enabled: true,
        destination_enabled: true,
        formatter_config: {},
        route_rate_limit: {},
        failure_policy: 'LOG_AND_CONTINUE',
      },
    ]
    const catalogRoutes: RouteRead[] = [
      { id: 1, stream_id: 10, destination_id: 5, enabled: true },
      { id: 2, stream_id: 10, destination_id: 6, enabled: true, failure_policy: 'DISABLE_ROUTE_ON_FAILURE' },
    ]

    const result = buildWizardDestinationsFromRouteSources(mappingRoutes, catalogRoutes, [
      { id: 5, destination_type: 'WEBHOOK_POST' },
      { id: 6, destination_type: 'SYSLOG_TCP' },
    ])

    expect(result.routeDrafts.map((draft) => draft.key)).toEqual(['route-1', 'route-2'])
    expect(result.routeDrafts[1]?.failurePolicy).toBe('DISABLE_ROUTE_ON_FAILURE')
  })
})
