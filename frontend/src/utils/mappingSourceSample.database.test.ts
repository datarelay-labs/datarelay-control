import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fetchConnectorByIdMock,
  fetchStreamMappingUiConfigMock,
  fetchStreamByIdMock,
  runConnectorAuthTestMock,
  runHttpApiTestMock,
} = vi.hoisted(() => ({
  fetchConnectorByIdMock: vi.fn(),
  fetchStreamMappingUiConfigMock: vi.fn(),
  fetchStreamByIdMock: vi.fn(),
  runConnectorAuthTestMock: vi.fn(),
  runHttpApiTestMock: vi.fn(),
}))

vi.mock('../api/gdcConnectors', () => ({
  fetchConnectorById: fetchConnectorByIdMock,
}))

vi.mock('../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: fetchStreamMappingUiConfigMock,
}))

vi.mock('../api/gdcStreams', () => ({
  fetchStreamById: fetchStreamByIdMock,
}))

vi.mock('../api/gdcRuntimePreview', () => ({
  runConnectorAuthTest: runConnectorAuthTestMock,
  runHttpApiTest: runHttpApiTestMock,
}))

import { fetchMappingSourceSample, loadMappingWorkspaceContext } from './mappingSourceSample'

const DB_QUERY = 'SELECT id, severity FROM public.events'

describe('fetchMappingSourceSample for DATABASE_QUERY streams (E-026)', () => {
  beforeEach(() => {
    fetchConnectorByIdMock.mockReset()
    fetchStreamMappingUiConfigMock.mockReset()
    fetchStreamByIdMock.mockReset()
    runConnectorAuthTestMock.mockReset()
    runHttpApiTestMock.mockReset()

    fetchStreamByIdMock.mockResolvedValue({
      id: 2,
      connector_id: 9,
      stream_type: 'DATABASE_QUERY',
      config_json: {
        query: DB_QUERY,
        query_params: { tenant: 'acme' },
        query_timeout_seconds: 45,
        checkpoint_mode: 'SINGLE_COLUMN',
        checkpoint_column: 'id',
      },
    })
    fetchStreamMappingUiConfigMock.mockResolvedValue({
      source_type: 'DATABASE_QUERY',
      source_config: { db_type: 'POSTGRESQL' },
      mapping: { event_array_path: '', event_root_path: '' },
    })
    fetchConnectorByIdMock.mockResolvedValue({ id: 9, name: 'pg-connector' })
  })

  it('sends the saved SQL query (not an HTTP request config) to the sample preview', async () => {
    runHttpApiTestMock.mockResolvedValue({
      ok: true,
      database_query_sample_rows: [
        { id: 1, severity: 'high' },
        { id: 2, severity: 'low' },
      ],
    })

    const result = await fetchMappingSourceSample(2)

    expect(runHttpApiTestMock).toHaveBeenCalledTimes(1)
    const payload = runHttpApiTestMock.mock.calls[0][0] as {
      connector_id?: number
      stream_config: Record<string, unknown>
      fetch_sample?: boolean
    }
    expect(payload.connector_id).toBe(9)
    expect(payload.fetch_sample).toBe(true)
    expect(payload.stream_config.query).toBe(DB_QUERY)
    expect(payload.stream_config.query_params).toEqual({ tenant: 'acme' })
    expect(payload.stream_config.query_timeout_seconds).toBe(45)
    expect(payload.stream_config).not.toHaveProperty('endpoint')
    expect(payload.stream_config).not.toHaveProperty('method')
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        sourceType: 'DATABASE_QUERY',
        extractedEvents: [
          { id: 1, severity: 'high' },
          { id: 2, severity: 'low' },
        ],
        recordsLabel: '2 row(s)',
      }),
    )
  })

  it('degrades to an unavailable sample instead of throwing when the preview request fails', async () => {
    runHttpApiTestMock.mockRejectedValue(new Error('400: database unreachable'))

    const result = await fetchMappingSourceSample(2)

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        sourceType: 'DATABASE_QUERY',
        rawPayload: null,
        extractedEvents: [],
        message: '400: database unreachable',
      }),
    )
  })

  it('lets the Route editor workspace load even when the source sample cannot be fetched', async () => {
    runHttpApiTestMock.mockRejectedValue(new Error('400: database unreachable'))

    const ctx = await loadMappingWorkspaceContext(2)

    expect(ctx).not.toBeNull()
    expect(ctx?.connectorName).toBe('pg-connector')
    expect(ctx?.sample.ok).toBe(false)
    expect(ctx?.sample.message).toBe('400: database unreachable')
  })
})
