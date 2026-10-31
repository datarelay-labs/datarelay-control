import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MappingUIConfigResponse } from '../../../api/types/gdcApi'
import type { StreamGovernanceResponse } from '../../../api/gdcStreamGovernance'
import type { WizardRouteDraft } from './wizard-state'

const fetchStreamById = vi.fn()
const fetchStreamMappingUiConfig = vi.fn()
const fetchRoutesList = vi.fn()
const fetchDestinationsList = vi.fn()
const fetchStreamProtectionRules = vi.fn()
const fetchStreamGovernance = vi.fn()

vi.mock('../../../api/gdcStreams', () => ({
  fetchStreamById: (...args: unknown[]) => fetchStreamById(...args),
}))

vi.mock('../../../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: (...args: unknown[]) => fetchStreamMappingUiConfig(...args),
}))

vi.mock('../../../api/gdcRoutes', () => ({
  fetchRoutesList: (...args: unknown[]) => fetchRoutesList(...args),
}))

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

vi.mock('../../../api/gdcProtection', () => ({
  fetchStreamProtectionRules: (...args: unknown[]) => fetchStreamProtectionRules(...args),
}))

vi.mock('../../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../../api/gdcStreamGovernance', () => ({
  fetchStreamGovernance: (...args: unknown[]) => fetchStreamGovernance(...args),
}))

function mappingConfig(overrides: Partial<MappingUIConfigResponse> = {}): MappingUIConfigResponse {
  return {
    stream_id: 9,
    stream_name: 'Kept',
    stream_enabled: false,
    stream_status: 'STOPPED',
    source_id: 1,
    source_type: 'HTTP_POLL',
    source_config: {},
    mapping: {
      exists: false,
      event_array_path: null,
      event_root_path: null,
      field_mappings: {},
      raw_payload_mode: null,
    },
    enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    routes: [],
    message: 'ok',
    ...overrides,
  }
}

describe('Stream edit persisted Route classification floors', () => {
  const routes = [{ key: 'route-3' }, { key: 'route-7' }] as WizardRouteDraft[]
  const governance = (route_overrides: StreamGovernanceResponse['route_overrides']): StreamGovernanceResponse => ({
    stream_id: 9, enabled: true, updated_at: 'stream-server-revision',
    rules: [], route_overrides,
  })

  it('rehydrates an actual server Route floor instead of incorrectly showing Shared', async () => {
    const { hydrateStreamClassificationFloors } = await import('./wizard-stream-hydrate')
    expect(hydrateStreamClassificationFloors(governance([
      {
        route_id: 3, field_path: null, classification_level: 'CONFIDENTIAL',
        protection_action: null, delivery_behavior: null, enabled: true,
      },
    ]), routes)).toEqual([{
      key: 'persisted-classification-route-3', routeDraftKey: 'route-3',
      classificationLevel: 'CONFIDENTIAL', enabled: true,
    }])
  })

  it('excludes unrelated, disabled, and field-specific foreign Governance overrides', async () => {
    const { hydrateStreamClassificationFloors } = await import('./wizard-stream-hydrate')
    expect(hydrateStreamClassificationFloors(governance([
      { route_id: 23, classification_level: 'RESTRICTED', enabled: true },
      { route_id: 7, classification_level: 'PUBLIC', enabled: false },
      { route_id: 3, field_path: '$.email', classification_level: 'RESTRICTED', enabled: true },
      { route_id: 3, classification_level: 'INTERNAL', protection_action: 'audit', enabled: true },
      { route_id: 3, classification_level: 'CONFIDENTIAL', enabled: true },
    ]), routes)).toEqual([{
      key: 'persisted-classification-route-3', routeDraftKey: 'route-3',
      classificationLevel: 'CONFIDENTIAL', enabled: true,
    }])
  })

  it('fails closed on conflicting or invalid active Route classification floors', async () => {
    const { hydrateStreamClassificationFloors } = await import('./wizard-stream-hydrate')
    expect(hydrateStreamClassificationFloors(governance([
      { route_id: 3, classification_level: 'INTERNAL', enabled: true },
      { route_id: 3, classification_level: 'CONFIDENTIAL', enabled: true },
    ]), routes)).toBeNull()
    expect(hydrateStreamClassificationFloors(governance([
      { route_id: 3, classification_level: 'UNRECOGNIZED', enabled: true },
    ]), routes)).toBeNull()
  })

  it('keeps the unavailable Governance snapshot separate from invented success', async () => {
    const { hydrateStreamClassificationFloors } = await import('./wizard-stream-hydrate')
    expect(hydrateStreamClassificationFloors(null, routes)).toBeNull()
  })
})

describe('edit hydrate fidelity', () => {
  beforeEach(() => {
    fetchStreamById.mockReset()
    fetchStreamMappingUiConfig.mockReset()
    fetchRoutesList.mockReset()
    fetchDestinationsList.mockReset()
    fetchStreamProtectionRules.mockReset()
    fetchStreamProtectionRules.mockResolvedValue({ stream_id: 9, protection_enabled: true, rules: [], rule_count: 0 })
    fetchStreamGovernance.mockReset()
    fetchStreamGovernance.mockResolvedValue({ stream_id: 9, enabled: false, rules: [], route_overrides: [] })
    fetchRoutesList.mockResolvedValue([])
    fetchDestinationsList.mockResolvedValue([])
    fetchStreamById.mockResolvedValue({
      id: 9,
      name: 'Kept',
      connector_id: null,
      polling_interval: 60,
      config_json: {},
      rate_limit_json: {},
    })
  })

  it('does not confirm an editable state when the mapping UI read fails', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(null)
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    await expect(hydrateWizardStateFromStream(9)).resolves.toBeNull()
  })

  it('fails closed when the Route catalog cannot be read instead of showing no Routes', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig())
    // null means a failed API/catalog read; [] means the server confirmed no Routes.
    fetchRoutesList.mockResolvedValue(null)
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    await expect(hydrateWizardStateFromStream(9)).resolves.toBeNull()
    expect(fetchRoutesList).toHaveBeenCalled()
  })

  it('fails closed when Governance is unreadable instead of showing every Route as Shared', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig())
    fetchStreamGovernance.mockResolvedValue(null)
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    await expect(hydrateWizardStateFromStream(9)).resolves.toBeNull()
    expect(fetchStreamGovernance).toHaveBeenCalledWith(9)
  })

  it('accepts an explicit empty mapping response and restores persisted source and schema-drift config', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(
      mappingConfig({
        source_type: 'REMOTE_FILE_POLLING',
        mapping: {
          exists: true,
          event_array_path: null,
          event_root_path: null,
          field_mappings: {
            message: '$.message',
            transform_rules: [{ mode: 'jsonata', output_field: 'host', expression: 'host' }],
          },
          raw_payload_mode: 'full_event',
        },
        enrichment: {
          exists: true,
          enabled: true,
          enrichment: { vendor: 'acme' },
          override_policy: 'KEEP_EXISTING',
        },
      }),
    )
    fetchStreamById.mockResolvedValue({
      id: 9,
      name: 'Kept',
      connector_id: null,
      polling_interval: 60,
      rate_limit_json: {},
      config_json: {
        remote_directory: '/prod/logs',
        file_pattern: '*.json',
        max_files_per_run: 100,
        governance: {
          schema_drift_policy: {
            unknown_normal_field_policy: 'require_review',
            unknown_sensitive_field_policy: 'quarantine',
          },
        },
      },
    })
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    const state = await hydrateWizardStateFromStream(9)
    expect(state).not.toBeNull()
    expect(state?.stream.remoteDirectory).toBe('/prod/logs')
    expect(state?.stream.filePattern).toBe('*.json')
    expect(state?.stream.maxFilesPerRun).toBe(100)
    expect(state?.dataProtection.unknownNormalFieldPolicy).toBe('require_review')
    expect(state?.dataProtection.unknownSensitiveFieldPolicy).toBe('quarantine')
    expect(state?.mappingRawPayloadMode).toBe('full_event')
    expect(state?.transformRules).toHaveLength(1)
    expect(state?.enrichment.some((rule) => rule.fieldName === 'vendor')).toBe(true)
    expect(state?.mapping.some((row) => row.outputField === 'message')).toBe(true)
  })

  it('hydrates persisted stream protection rules into the active editor read-back state', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig({ source_type: 'HTTP_API_POLLING' }))
    fetchStreamProtectionRules.mockResolvedValue({
      stream_id: 9,
      protection_enabled: true,
      rule_count: 1,
      rules: [{
        id: 41,
        stream_id: 9,
        field_path: '$.message',
        sensitivity_class: 'pii',
        protection_mode: 'partial_mask',
        enabled: true,
        source_finding_id: null,
        created_by: 'admin',
        created_at: '2026-10-07T00:00:00Z',
        updated_at: '2026-10-07T00:00:00Z',
      }],
    })
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    const state = await hydrateWizardStateFromStream(9)
    expect(fetchStreamProtectionRules).toHaveBeenCalledWith(9, true)
    expect(state?.dataProtection.intents).toEqual([
      expect.objectContaining({
        detectedField: '$.message',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      }),
    ])
  })

  it('hydrates persisted Union Schema and incremental query request state for browser read-back', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig({ source_type: 'HTTP_API_POLLING' }))
    fetchStreamById.mockResolvedValue({
      id: 9,
      name: 'Incremental HTTP',
      connector_id: null,
      polling_interval: 60,
      rate_limit_json: {},
      config_json: {
        method: 'GET',
        endpoint: '/events',
        params: {
          tenant: 'acme',
          id_gt: '{{checkpoint.last_timestamp}}',
          id_lte: '{{now}}',
          limit: '100',
        },
        runtime_ui: {
          incremental_request: {
            pattern: 'query_params',
            draft: 'id_gt={{checkpoint.last_timestamp}}\nid_lte={{now}}\nlimit=100',
            base_method: 'GET',
            base_params: { tenant: 'acme' },
            base_body: null,
          },
        },
        union_schema: {
          total_events: 12,
          fields: [
            { field_path: '$.id', field_type: 'integer', occurrence_count: 12, sample_values: [1, 2] },
            { field_path: '$.rare_field', field_type: 'string', occurrence_count: 1, sample_values: ['rare'] },
          ],
        },
      },
    })
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    const state = await hydrateWizardStateFromStream(9)
    expect(state?.apiTest.unionSchema).toMatchObject({ total_events: 12 })
    expect(state?.apiTest.unionSchema?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ field_path: '$.rare_field', occurrence_count: 1 })]),
    )
    expect(state?.stream.incrementalRequestPattern).toBe('query_params')
    expect(state?.stream.incrementalRequestDraft).toContain('id_gt={{checkpoint.last_timestamp}}')
    expect(state?.stream.params).toEqual([
      expect.objectContaining({ key: 'tenant', value: 'acme' }),
    ])

    expect(state).not.toBeNull()
    if (!state) return
    state.connector.connectorId = 11
    state.connector.sourceId = 1
    state.connector.sourceType = 'HTTP_API_POLLING'
    state.stream.incrementalRequestPattern = 'none'
    state.stream.incrementalRequestDraft = ''
    const { buildStreamCreatePayload } = await import('./wizard-state')
    const cleared = buildStreamCreatePayload(state)
    expect(cleared?.config_json).toMatchObject({
      params: { tenant: 'acme' },
      runtime_ui: {
        incremental_request: {
          pattern: 'none',
          draft: '',
          base_params: { tenant: 'acme' },
        },
      },
    })
    expect((cleared?.config_json.params as Record<string, unknown>) ?? {}).not.toHaveProperty('id_gt')
  })

  it('round-trips an explicit Elasticsearch incremental pattern without leaking the effective body into the base request', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig({ source_type: 'HTTP_API_POLLING' }))
    fetchStreamById.mockResolvedValue({
      id: 9,
      name: 'Search stream',
      connector_id: null,
      polling_interval: 60,
      rate_limit_json: {},
      config_json: {
        method: 'POST',
        endpoint: '/_search',
        params: { tenant: 'acme' },
        body: '{"query":{"range":{"@timestamp":{"gt":"{{checkpoint.last_timestamp}}"}}}}',
        runtime_ui: {
          incremental_request: {
            pattern: 'elasticsearch',
            draft: '{"query":{"range":{"@timestamp":{"gt":"{{checkpoint.last_timestamp}}"}}}}',
            base_method: 'POST',
            base_params: { tenant: 'acme' },
            base_body: '{"query":{"term":{"environment":"prod"}}}',
          },
        },
      },
    })
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    const state = await hydrateWizardStateFromStream(9)
    expect(state?.stream.incrementalRequestPattern).toBe('elasticsearch')
    expect(state?.stream.incrementalRequestDraft).toContain('{{checkpoint.last_timestamp}}')
    expect(state?.stream.requestBody).toBe('{"query":{"term":{"environment":"prod"}}}')
    expect(state?.stream.params).toEqual([
      expect.objectContaining({ key: 'tenant', value: 'acme' }),
    ])
  })

  it('hydrates the database query timeout from the runtime key', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig({ source_type: 'DATABASE_QUERY' }))
    fetchStreamById.mockResolvedValue({
      id: 9,
      name: 'Query',
      connector_id: null,
      polling_interval: 60,
      rate_limit_json: {},
      config_json: { query: 'select 1', query_timeout_seconds: 75, checkpoint_mode: 'NONE' },
    })
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    const state = await hydrateWizardStateFromStream(9)
    expect(state?.stream.timeoutSec).toBe(75)
    expect(state?.stream.sqlQuery).toBe('select 1')
    expect(state?.stream.dbCheckpointMode).toBe('NONE')
  })

  it('fails closed when persisted schema-drift policy is unreadable', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig())
    fetchStreamById.mockResolvedValue({
      id: 9,
      name: 'Kept',
      connector_id: null,
      polling_interval: 60,
      rate_limit_json: {},
      config_json: { governance: { schema_drift_policy: 'not-an-object' } },
    })
    const { hydrateWizardStateFromStream } = await import('./wizard-stream-hydrate')
    await expect(hydrateWizardStateFromStream(9)).resolves.toBeNull()
  })
})
