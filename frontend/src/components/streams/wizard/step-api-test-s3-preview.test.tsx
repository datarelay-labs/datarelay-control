import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StepApiTest } from './step-api-test'
import { buildInitialState } from './wizard-state'

const previewMocks = vi.hoisted(() => ({
  runConnectorAuthTest: vi.fn(),
  runHttpApiTest: vi.fn(),
}))

vi.mock('../../../api/gdcRuntimePreview', () => ({
  runConnectorAuthTest: previewMocks.runConnectorAuthTest,
  runHttpApiTest: previewMocks.runHttpApiTest,
}))

describe('S3 Run Test actual object preview', () => {
  it('uses connectivity probe then actual bounded S3 object rows instead of a synthetic placeholder', async () => {
    previewMocks.runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'S3_OBJECT_POLLING',
      s3_endpoint_reachable: true,
      s3_auth_ok: true,
      s3_bucket_exists: true,
      s3_object_count_preview: 2,
      s3_sample_keys: ['logs/a.ndjson'],
    })
    previewMocks.runHttpApiTest.mockResolvedValue({
      ok: true,
      request: {
        method: 'S3_OBJECT_POLLING',
        url: 's3://security-logs/logs/',
        headers_masked: {},
      },
      actual_request_sent: {
        method: 'S3_OBJECT_POLLING',
        url: 's3://security-logs/logs/',
        endpoint: null,
        query_params: {},
        headers_masked: {},
        json_body_masked: null,
        timeout_seconds: 30,
      },
      response: {
        status_code: 200,
        latency_ms: 8,
        headers: {},
        raw_body: '[{"id":"evt-1"},{"id":"evt-2"}]',
        parsed_json: [
          { id: 'evt-1', message: 'one', s3_key: 'logs/a.ndjson' },
          { id: 'evt-2', message: 'two', s3_key: 'logs/a.ndjson' },
        ],
        content_type: 'application/json',
      },
      analysis: {
        response_summary: {
          root_type: 'array',
          approx_size_bytes: 120,
          top_level_keys: [],
          item_count_root: 2,
          truncation: null,
        },
        detected_arrays: [],
        detected_checkpoint_candidates: [],
        sample_event: { id: 'evt-1', message: 'one', s3_key: 'logs/a.ndjson' },
        selected_event_array_default: null,
        flat_preview_fields: ['$.id', '$.message', '$.s3_key'],
        preview_error: null,
      },
      steps: [],
    })

    const state = buildInitialState()
    state.connector.connectorId = 17
    state.connector.sourceId = 23
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.connector.connectorName = 'Saved MinIO'
    state.stream.maxObjectsPerRun = 20
    const onChange = vi.fn()

    render(
      <MemoryRouter>
        <StepApiTest state={state} onChange={onChange} />
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Run Test' }))

    await waitFor(() => expect(previewMocks.runConnectorAuthTest).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(previewMocks.runHttpApiTest).toHaveBeenCalledTimes(1))
    expect(previewMocks.runHttpApiTest).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 17,
        checkpoint: null,
        fetch_sample: true,
      }),
    )

    const finalState = onChange.mock.calls
      .map(([value]) => value)
      .find((value) => value?.status === 'success')

    expect(finalState).toMatchObject({
      status: 'success',
      ok: true,
      method: 'S3_OBJECT_POLLING',
      requestUrl: 's3://security-logs/logs/',
      eventCount: 2,
      parsedJson: [
        { id: 'evt-1', message: 'one', s3_key: 'logs/a.ndjson' },
        { id: 'evt-2', message: 'two', s3_key: 'logs/a.ndjson' },
      ],
      s3ConnectivityPassed: true,
    })
    expect(JSON.stringify(finalState)).not.toContain('s3-wizard-preview')
  })
})
