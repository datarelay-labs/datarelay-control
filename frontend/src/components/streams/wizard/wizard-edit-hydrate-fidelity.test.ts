import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MappingUIConfigResponse } from '../../../api/types/gdcApi'

const fetchStreamById = vi.fn()
const fetchStreamMappingUiConfig = vi.fn()
const fetchRoutesList = vi.fn()
const fetchDestinationsList = vi.fn()

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

vi.mock('../../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../../api/gdcStreamGovernance', () => ({
  fetchStreamGovernance: vi.fn(async () => null),
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

describe('edit hydrate fidelity', () => {
  beforeEach(() => {
    fetchStreamById.mockReset()
    fetchStreamMappingUiConfig.mockReset()
    fetchRoutesList.mockReset()
    fetchDestinationsList.mockReset()
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
          id_gt: '{{checkpoint.last_timestamp}}',
          id_lte: '{{now}}',
          limit: '100',
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
    expect(state?.stream.params).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'id_gt', value: '{{checkpoint.last_timestamp}}' })]),
    )
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
