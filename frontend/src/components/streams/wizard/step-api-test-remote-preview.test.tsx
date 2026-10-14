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

function remoteState() {
  const state = buildInitialState()
  state.connector.connectorId = 31
  state.connector.sourceId = 41
  state.connector.sourceType = 'REMOTE_FILE_POLLING'
  state.connector.connectorName = 'Saved SFTP'
  state.stream.remoteDirectory = '/upload/security'
  state.stream.filePattern = '*.ndjson'
  state.stream.parserType = 'NDJSON'
  return state
}

const successfulProbe = {
  ok: true,
  auth_type: 'REMOTE_FILE_POLLING',
  ssh_reachable: true,
  ssh_auth_ok: true,
  sftp_available: true,
  remote_directory_accessible: true,
  matched_file_count: 1,
  sample_remote_paths: ['/upload/security/events.ndjson'],
  host_key_status: 'strict_verified',
}

describe('Remote File Run Test actual file preview', () => {
  it('keeps actual parsed remote-file rows as the sample after a successful probe', async () => {
    previewMocks.runConnectorAuthTest.mockResolvedValue(successfulProbe)
    previewMocks.runHttpApiTest.mockResolvedValue({
      ok: true,
      request: {
        method: 'REMOTE_FILE_POLLING',
        url: 'sftp://sftp.example.test/upload/security',
        headers_masked: {},
      },
      actual_request_sent: {
        method: 'REMOTE_FILE_POLLING',
        url: 'sftp://sftp.example.test/upload/security',
        endpoint: null,
        query_params: {},
        headers_masked: {},
        json_body_masked: null,
        timeout_seconds: 30,
      },
      response: {
        status_code: 200,
        latency_ms: 12,
        headers: {},
        raw_body: '[{"id":"r1"},{"id":"r2"}]',
        parsed_json: [
          { id: 'r1', message: 'one', gdc_remote_path: '/upload/security/events.ndjson' },
          { id: 'r2', message: 'two', gdc_remote_path: '/upload/security/events.ndjson' },
        ],
        content_type: 'application/json',
      },
      analysis: null,
      steps: [],
    })
    const onChange = vi.fn()

    render(
      <MemoryRouter>
        <StepApiTest state={remoteState()} onChange={onChange} />
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Run Test' }))

    await waitFor(() => expect(previewMocks.runConnectorAuthTest).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(previewMocks.runHttpApiTest).toHaveBeenCalledTimes(1))
    expect(previewMocks.runConnectorAuthTest).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 31,
        remote_file_stream_config: expect.objectContaining({
          remote_directory: '/upload/security',
          file_pattern: '*.ndjson',
        }),
      }),
    )
    expect(previewMocks.runHttpApiTest).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 31,
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
      method: 'REMOTE_FILE_POLLING',
      eventCount: 2,
      parsedJson: [
        { id: 'r1', message: 'one', gdc_remote_path: '/upload/security/events.ndjson' },
        { id: 'r2', message: 'two', gdc_remote_path: '/upload/security/events.ndjson' },
      ],
      remoteProbe: expect.objectContaining({
        host_key_status: 'strict_verified',
        matched_file_count: 1,
      }),
    })
  })

  it('reports file fetch or parser failure as an error after connectivity already succeeded', async () => {
    previewMocks.runConnectorAuthTest.mockResolvedValue(successfulProbe)
    previewMocks.runHttpApiTest.mockRejectedValue(
      new Error('Remote file parser rejected invalid NDJSON on line 2'),
    )
    const onChange = vi.fn()

    render(
      <MemoryRouter>
        <StepApiTest state={remoteState()} onChange={onChange} />
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Run Test' }))

    const finalState = await waitFor(() => {
      const found = onChange.mock.calls
        .map(([value]) => value)
        .find((value) => value?.errorCode === 'remote_file_sample_fetch_failed')
      expect(found).toBeDefined()
      return found
    })

    expect(finalState).toMatchObject({
      status: 'error',
      ok: false,
      errorCode: 'remote_file_sample_fetch_failed',
      errorType: 'remote_file_sample_fetch_failed',
      s3ConnectivityPassed: false,
      remoteProbe: expect.objectContaining({
        ssh_reachable: true,
        ssh_auth_ok: true,
        sftp_available: true,
      }),
    })
    expect(finalState?.errorMessage).toContain('invalid NDJSON on line 2')
    expect(finalState?.hint).toMatch(/connectivity succeeded/i)
  })
})
