import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runHttpApiTest } from '../../../api/gdcRuntimePreview'
import { buildInitialState, type WizardIncrementalRequestTestResult } from './wizard-state'
import {
  IncrementalRequestTestButton,
  IncrementalRequestTestSection,
  useIncrementalRequestTest,
} from './incremental-request-test-section'
import { renderHook } from '@testing-library/react'

vi.mock('../../../api/gdcRuntimePreview', () => ({
  runHttpApiTest: vi.fn(),
}))

const runHttpApiTestMock = vi.mocked(runHttpApiTest)

describe('IncrementalRequestTestButton', () => {
  it('renders inactive styling and blocks click when disabled with reason', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <IncrementalRequestTestButton
        testing={false}
        disabled
        disabledReason="Select a checkpoint field with values first."
        onClick={onClick}
      />,
    )

    const button = screen.getByTestId('incremental-request-test-button')
    expect(button).toBeDisabled()
    expect(button.className).toContain('bg-slate-200')
    expect(button.className).not.toContain('bg-violet-600')
    expect(screen.getByText('Select a checkpoint field with values first.')).toBeInTheDocument()

    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('useIncrementalRequestTest', () => {
  it('disables test when checkpoint Example is a non-scalar object', () => {
    const state = buildInitialState()
    state.stream.incrementalRequestPattern = 'visualsearch_query'
    state.stream.incrementalRequestDraft = '{"queryPath":[]}'
    state.stream.checkpointSourcePath = '$.executionStep'

    const { result } = renderHook(() =>
      useIncrementalRequestTest({
        state,
        eventSourceRecords: [{ creationTime: '2024-06-21T02:00:00.000Z' }],
        previewRecord: { executionStep: { id: '6655847b' } },
        eventArrayPath: '$',
        eventRootPath: '',
        checkpointSourcePath: '$.executionStep',
        checkpointFieldType: 'STRING',
        pattern: 'visualsearch_query',
        draft: state.stream.incrementalRequestDraft,
        resolvedSampleValue: { id: '6655847b' },
      }),
    )

    expect(result.current.testDisabled).toBe(true)
    expect(result.current.testDisabledReason).toBe('Select a checkpoint field with values first.')
  })
})

// Old code reported `status: 'success'` / "Incremental request looks good." whenever the request returned records,
// even when none of them was newer than the tested checkpoint. The warning assertions below fail on the old code.
describe('useIncrementalRequestTest newer-than-checkpoint verdict', () => {
  // Second-latest sample value (11:00) becomes the tested checkpoint.
  const sampleRecords = [{ timestamp: '2026-10-29T11:00:00Z' }, { timestamp: '2026-10-29T12:00:00Z' }]

  beforeEach(() => {
    runHttpApiTestMock.mockReset()
  })

  async function runWithResponse(items: Array<Record<string, unknown>>) {
    runHttpApiTestMock.mockResolvedValue({
      ok: true,
      response: { status_code: 200, latency_ms: 5, parsed_json: { items }, raw_body: '{}' },
    } as unknown as Awaited<ReturnType<typeof runHttpApiTest>>)
    const state = buildInitialState()
    const draft = 'timestamp_gt={{checkpoint.last_timestamp}}'
    state.stream.incrementalRequestPattern = 'query_params'
    state.stream.incrementalRequestDraft = draft
    state.stream.checkpointSourcePath = '$.timestamp'
    const onStreamPatch = vi.fn()
    const { result } = renderHook(() =>
      useIncrementalRequestTest({
        state,
        eventSourceRecords: sampleRecords,
        previewRecord: sampleRecords[0],
        eventArrayPath: '$.items',
        eventRootPath: '',
        checkpointSourcePath: '$.timestamp',
        checkpointFieldType: 'TIMESTAMP',
        pattern: 'query_params',
        draft,
        onStreamPatch,
      }),
    )
    expect(result.current.testDisabled).toBe(false)
    await act(async () => {
      await result.current.runTest()
    })
    expect(runHttpApiTestMock).toHaveBeenCalledTimes(1)
    expect(onStreamPatch).toHaveBeenCalled()
    const calls = onStreamPatch.mock.calls
    const patch = calls[calls.length - 1][0] as { incrementalRequestTestResult: WizardIncrementalRequestTestResult }
    return patch.incrementalRequestTestResult
  }

  it('reports a warning when records are returned but none is newer than the checkpoint', async () => {
    const res = await runWithResponse([{ timestamp: '2026-10-29T10:00:00Z' }, { timestamp: '2026-10-29T11:00:00Z' }])
    expect(res.status).toBe('warning')
    expect(res.warningCode).toBe('NO_NEWER_RECORDS')
    expect(res.newerRecordCount).toBe(0)
    expect(res.returnedRecordCount).toBe(2)
    expect(res.message).toContain('none is newer than the tested checkpoint')
  })

  it('reports success when at least one record is newer than the checkpoint', async () => {
    const res = await runWithResponse([{ timestamp: '2026-10-29T12:00:00Z' }])
    expect(res.status).toBe('success')
    expect(res.warningCode).toBeNull()
    expect(res.newerRecordCount).toBe(1)
    expect(res.message).toBe('Incremental request looks good.')
  })
})

describe('IncrementalRequestTestSection warning state', () => {
  it('renders a warning, not success, for NO_NEWER_RECORDS', () => {
    const state = buildInitialState()
    const result: WizardIncrementalRequestTestResult = {
      status: 'warning',
      httpStatus: 200,
      durationMs: 5,
      returnedRecordCount: 2,
      newerRecordCount: 0,
      warningCode: 'NO_NEWER_RECORDS',
      testedCheckpointDisplay: '2026-10-29T11:00:00Z',
      substitutedRequestBody: 'timestamp_gt=2026-10-29T11:00:00Z',
      sampleRecords: [{ timestamp: '2026-10-29T10:00:00Z' }],
      rawResponseBody: '{}',
      message: 'Request succeeded and returned 2 record(s), but none is newer than the tested checkpoint.',
      testedAt: Date.now(),
      signature: 'sig-1',
    }
    state.stream.incrementalRequestTestResult = result
    state.stream.incrementalRequestTestSignature = 'sig-1'

    render(
      <IncrementalRequestTestSection
        state={state}
        pattern="query_params"
        testDisabled={false}
        testDisabledReason={null}
        signature="sig-1"
      />,
    )

    const box = screen.getByTestId('incremental-request-test-result-status')
    expect(box).toHaveAttribute('data-status', 'warning')
    expect(box.className).toContain('border-amber-300/70')
    expect(screen.getByText(/Warning · 200/)).toBeInTheDocument()
    expect(screen.queryByText(/Success/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument()
    expect(screen.getByText('Newer than checkpoint: 0')).toBeInTheDocument()
    expect(screen.getByText('Returned records: 2')).toBeInTheDocument()
  })
})
