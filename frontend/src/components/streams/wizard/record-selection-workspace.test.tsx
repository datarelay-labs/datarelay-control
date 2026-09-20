import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildInitialState } from './wizard-state'
import { RecordSelectionWorkspace } from './record-selection-workspace'
import { getOperationalSample } from './wizard-operational-samples'
import { buildIncrementalRequestPlan } from './wizard-incremental-request'
import { runExtractionValidate } from '../../../api/gdcRuntimePreview'

vi.mock('../../../api/gdcRuntimePreview', () => ({
  runExtractionValidate: vi.fn(),
}))

const ROOT_ARRAY = [{ creationTime: 100, locale: 'en' }, { creationTime: 200, locale: 'fr' }]

function renderWorkspace(
  overrides: {
    eventArrayPath?: string
    eventRootPath?: string
    checkpointSourcePath?: string
    payload?: unknown
    recordSelectionMode?: 'basic' | 'advanced'
  } = {},
) {
  const state = buildInitialState()
  state.apiTest.status = 'success'
  state.apiTest.ok = true
  state.apiTest.parsedJson = overrides.payload ?? ROOT_ARRAY
  state.apiTest.rawResponse = overrides.payload ?? ROOT_ARRAY
  state.stream.eventArrayPath = overrides.eventArrayPath ?? '$'
  state.stream.eventRootPath = overrides.eventRootPath ?? ''
  state.stream.checkpointSourcePath = overrides.checkpointSourcePath ?? ''
  state.stream.recordSelectionMode = overrides.recordSelectionMode ?? 'basic'
  state.stream.useWholeResponseAsEvent = false

  const onSetEventArrayPath = vi.fn()
  const onSetEventRootPath = vi.fn()
  const onSetCheckpoint = vi.fn()
  const onStreamPatch = vi.fn()

  render(
    <RecordSelectionWorkspace
      state={state}
      onSetEventArrayPath={onSetEventArrayPath}
      onSetEventRootPath={onSetEventRootPath}
      onSetCheckpoint={onSetCheckpoint}
      onStreamPatch={onStreamPatch}
    />,
  )

  return { onSetEventArrayPath, onSetEventRootPath, onSetCheckpoint, onStreamPatch }
}

describe('RecordSelectionWorkspace', () => {
  it('shows root array summary and preview sample', () => {
    renderWorkspace()
    expect(screen.getByText('Record Selection')).toBeTruthy()
    expect(screen.getByTestId('summary-event-source')).toHaveTextContent('$')
    expect(screen.getByTestId('summary-preview')).toHaveTextContent('$[0]')
    expect(screen.getByTestId('summary-runtime')).toHaveTextContent('$[*]')
    expect(screen.getByTestId('summary-records')).toHaveTextContent('2')
  })

  it('shows CloudTrail-style extraction summary', () => {
    const sample = getOperationalSample('aws_cloudtrail')
    renderWorkspace({
      payload: sample.payload,
      eventArrayPath: '$.Records',
      eventRootPath: '$.event',
    })
    expect(screen.getByTestId('summary-runtime')).toHaveTextContent('$.Records[*].event')
    expect(screen.getByTestId('summary-preview')).toHaveTextContent('$.Records[0]')
    expect(screen.getByTestId('summary-records')).toHaveTextContent('10')
  })

  it('updates summary when event array is selected from the JSON tree', async () => {
    const user = userEvent.setup()
    const cloudtrail = getOperationalSample('aws_cloudtrail')
    const { onSetEventArrayPath } = renderWorkspace({ payload: cloudtrail.payload, eventArrayPath: '$' })

    for (const btn of screen.getAllByRole('button', { name: 'Event source' })) {
      await user.click(btn)
      const last = onSetEventArrayPath.mock.calls.at(-1)?.[0] as string | undefined
      if (last === '$.Records') break
    }

    expect(onSetEventArrayPath).toHaveBeenCalledWith('$.Records')
    expect(screen.getByTestId('summary-event-source')).toHaveTextContent('$.Records')
    expect(screen.getByTestId('summary-preview')).toHaveTextContent('$.Records[0]')
    expect(screen.getByTestId('summary-runtime')).toHaveTextContent('$.Records[*]')
    expect(screen.getByTestId('summary-records')).toHaveTextContent('10')
  })

  it('shows JSON tree and formatted response panels', async () => {
    const user = userEvent.setup()
    renderWorkspace()
    expect(screen.getByTestId('wizard-record-selection-json-tree')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Formatted' }))
    expect(screen.getByTestId('wizard-record-selection-formatted')).toBeInTheDocument()
  })

  it('shows JSON tree without per-row copy buttons', () => {
    renderWorkspace()
    expect(screen.getByTestId('wizard-record-selection-json-tree')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Copy JSONPath/i)).not.toBeInTheDocument()
  })

  it('updates checkpoint summary when a field checkpoint is chosen', async () => {
    const user = userEvent.setup()
    const { onSetCheckpoint } = renderWorkspace()

    for (const btn of screen.getAllByRole('button', { name: /^Sync position$/i })) {
      await user.click(btn)
      const patch = onSetCheckpoint.mock.calls.at(-1)?.[0] as { checkpointSourcePath?: string }
      if (patch?.checkpointSourcePath?.startsWith('$.')) {
        expect(patch.checkpointSourcePath).toBe('$.creationTime')
        expect(screen.getByTestId('summary-runtime')).toHaveTextContent('$[*]')
        return
      }
    }
    throw new Error('Expected a leaf checkpoint selection to set $.creationTime')
  })

  it('shows incremental summary without vendor pattern names and opens request preview drawer', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = ROOT_ARRAY
    state.stream.httpMethod = 'POST'
    state.stream.endpoint = '/rest/visualsearch/query/simple'
    state.stream.checkpointSourcePath = '$.creationTime'
    state.stream.incrementalRequestPattern = 'visualsearch_query'
    state.stream.incrementalRequestDraft =
      buildIncrementalRequestPlan('visualsearch_query', '$.creationTime')?.preview ?? ''

    render(
      <RecordSelectionWorkspace
        state={state}
        onSetEventArrayPath={vi.fn()}
        onSetEventRootPath={vi.fn()}
        onSetCheckpoint={vi.fn()}
      />,
    )

    expect(screen.getByTestId('incremental-pattern-summary')).toHaveTextContent('Custom Body')
    expect(screen.queryByText(/Visual Search/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Cybereason/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('incremental-preview-type-summary')).toHaveTextContent('JSON Body')
    expect(screen.queryByTestId('request-preview-drawer')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('open-request-preview-button'))
    expect(screen.getByTestId('request-preview-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('request-preview-draft').textContent).toContain('queryPath')
    expect(screen.getByTestId('incremental-request-test-button')).toBeInTheDocument()
  })

  it('offers query parameters pattern for GET streams', () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = ROOT_ARRAY
    state.stream.httpMethod = 'GET'
    state.stream.incrementalRequestPattern = 'query_params'
    state.stream.checkpointSourcePath = '$.creationTime'
    state.stream.incrementalRequestDraft = 'creationTime_gt={{checkpoint.last_timestamp}}'

    render(
      <RecordSelectionWorkspace
        state={state}
        onSetEventArrayPath={vi.fn()}
        onSetEventRootPath={vi.fn()}
        onSetCheckpoint={vi.fn()}
      />,
    )

    const select = screen.getByTestId('incremental-pattern-select') as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.text)
    expect(labels).toContain('Query Parameters')
    expect(labels).not.toContain('JSON Body')
    expect(screen.getByTestId('incremental-preview-type-summary')).toHaveTextContent('Query Parameters')
  })

  it('keeps operator-selected json body pattern even when endpoint implies visualsearch', async () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = ROOT_ARRAY
    state.stream.httpMethod = 'POST'
    state.stream.endpoint = '/rest/visualsearch/query/simple'
    state.stream.requestBody = '{"queryPath":[]}'
    state.stream.checkpointSourcePath = '$.creationTime'
    state.stream.incrementalRequestPattern = 'json_body'
    state.stream.incrementalRequestDraft = '{"from":"{{checkpoint.last_timestamp}}"}'

    const onStreamPatch = vi.fn()
    render(
      <RecordSelectionWorkspace
        state={state}
        onSetEventArrayPath={vi.fn()}
        onSetEventRootPath={vi.fn()}
        onSetCheckpoint={vi.fn()}
        onStreamPatch={onStreamPatch}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('incremental-pattern-summary')).toHaveTextContent('JSON Body')
    })
    expect(onStreamPatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ incrementalRequestPattern: 'visualsearch_query' }),
    )
  })

  it('validates custom extraction paths in advanced mode', async () => {
    const user = userEvent.setup()
    const mockedValidate = vi.mocked(runExtractionValidate)
    mockedValidate.mockResolvedValueOnce({
      ok: true,
      normalized_event_array_path: '$.data.resultIdToElementDataMap.*',
      normalized_event_root_path: '',
      normalized_checkpoint_path: '$.createdAtTime',
      event_count: 2,
      preview_events: [{ createdAtTime: 1 }, { createdAtTime: 2 }],
      checkpoint_values_preview: [1, 2],
      warnings: [],
      errors: [],
    })

    const { onSetEventArrayPath, onSetCheckpoint, onStreamPatch } = renderWorkspace({
      payload: {
        data: {
          resultIdToElementDataMap: {
            a: { createdAtTime: 1 },
            b: { createdAtTime: 2 },
          },
        },
      },
      eventArrayPath: '$.data.resultIdToElementDataMap.*',
      recordSelectionMode: 'advanced',
    })

    await user.click(screen.getByRole('button', { name: 'Validate & Preview' }))

    expect(mockedValidate).toHaveBeenCalled()
    expect(onSetEventArrayPath).toHaveBeenCalledWith('$.data.resultIdToElementDataMap.*')
    expect(onSetCheckpoint).toHaveBeenCalledWith({ checkpointSourcePath: '$.createdAtTime' })
    expect(onStreamPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        recordSelectionMode: 'advanced',
        customExtractionValidationOk: true,
      }),
    )
  })

  it('shows checkpoint extraction suggestions after a successful sample and Apply patches wizard state', async () => {
    const user = userEvent.setup()
    const payload = {
      data: {
        events: [
          { id: 'evt-1', timestamp: '2026-01-01T00:00:00Z', _id: 'a1' },
          { id: 'evt-2', timestamp: '2026-01-02T00:00:00Z', _id: 'a2' },
        ],
      },
    }
    const { onSetEventArrayPath, onSetCheckpoint, onStreamPatch } = renderWorkspace({ payload })

    expect(screen.getByTestId('checkpoint-extraction-suggestions-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('apply-event-array-path')).toBeInTheDocument()

    await user.click(screen.getByTestId('apply-event-array-path'))
    expect(onSetEventArrayPath).toHaveBeenCalledWith('$.data.events')

    await user.click(screen.getByTestId('apply-checkpoint-extraction'))
    expect(onSetCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointFieldType: 'TIMESTAMP',
        checkpointSourcePath: expect.stringContaining('timestamp'),
      }),
    )

    await user.click(screen.getByTestId('apply-sort-recommendation'))
    expect(onStreamPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.stringContaining('"fieldName": "timestamp"'),
        checkpointSecondaryPath: '$._id',
      }),
    )
  })

  it('does not auto-apply suggestions or show the panel without a successful sample', () => {
    const state = buildInitialState()
    state.apiTest.status = 'idle'
    state.apiTest.ok = false
    state.apiTest.parsedJson = null

    const onSetEventArrayPath = vi.fn()
    const onSetEventRootPath = vi.fn()
    const onSetCheckpoint = vi.fn()
    const onStreamPatch = vi.fn()

    render(
      <RecordSelectionWorkspace
        state={state}
        onSetEventArrayPath={onSetEventArrayPath}
        onSetEventRootPath={onSetEventRootPath}
        onSetCheckpoint={onSetCheckpoint}
        onStreamPatch={onStreamPatch}
      />,
    )

    expect(screen.queryByTestId('checkpoint-extraction-suggestions-panel')).not.toBeInTheDocument()
    expect(onSetEventArrayPath).not.toHaveBeenCalled()
    expect(onSetCheckpoint).not.toHaveBeenCalled()
    expect(onStreamPatch).not.toHaveBeenCalled()
  })
})
