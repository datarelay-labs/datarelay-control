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

import { fetchMappingSourceSample } from './mappingSourceSample'

describe('fetchMappingSourceSample webhook payload preview', () => {
  beforeEach(() => {
    fetchConnectorByIdMock.mockReset()
    fetchStreamMappingUiConfigMock.mockReset()
    fetchStreamByIdMock.mockReset()
    runConnectorAuthTestMock.mockReset()
    runHttpApiTestMock.mockReset()

    fetchStreamByIdMock.mockResolvedValue({
      id: 42,
      connector_id: 17,
      stream_type: 'WEBHOOK_RECEIVER',
      config_json: {},
    })
  })

  it('uses the saved Connector payload_preview as the webhook mapping sample', async () => {
    fetchStreamMappingUiConfigMock.mockResolvedValue({
      source_type: 'WEBHOOK_RECEIVER',
      source_config: {
        payload_preview: '{"items":[{"id":"wh-1","severity":"high"}]}',
      },
      mapping: {
        event_array_path: '$.items',
        event_root_path: '',
      },
    })

    const result = await fetchMappingSourceSample(42)

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sourceType: 'WEBHOOK_RECEIVER',
      rawPayload: { items: [{ id: 'wh-1', severity: 'high' }] },
      extractedEvents: [{ id: 'wh-1', severity: 'high' }],
      recordsLabel: 'webhook sample payload',
    }))
  })

  it('reports malformed saved payload_preview instead of silently substituting data', async () => {
    fetchStreamMappingUiConfigMock.mockResolvedValue({
      source_type: 'WEBHOOK_RECEIVER',
      source_config: {
        payload_preview: '{"items":',
      },
      mapping: {
        event_array_path: '$.items',
        event_root_path: '',
      },
    })

    const result = await fetchMappingSourceSample(42)

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      sourceType: 'WEBHOOK_RECEIVER',
      rawPayload: null,
      extractedEvents: [],
      message: 'Saved webhook payload preview is not valid JSON or NDJSON.',
    }))
  })
})
