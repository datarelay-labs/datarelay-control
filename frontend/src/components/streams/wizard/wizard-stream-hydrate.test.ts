import { describe, expect, it } from 'vitest'
import {
  applyRouteTransformConfigsToDraft,
  buildWizardDestinationsFromRouteSources,
  fullEventJsonataExpressionFromFieldMappings,
} from './wizard-stream-hydrate'
import type { MappingUIConfigRouteItem } from '../../../api/types/gdcApi'
import type { RouteRead } from '../../../api/gdcRoutes'
import type { RouteEnrichmentUiConfig, RouteMappingUiConfig } from '../../../api/gdcRouteTransform'
import { DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'

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
