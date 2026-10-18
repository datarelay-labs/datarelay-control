import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MappingWorkspace } from './mapping-workspace'

vi.mock('../../hooks/useMappingPreview', () => ({
  useMappingPreview: () => ({
    loading: false,
    error: null,
    mapped: null,
    final: null,
    validationWarnings: [],
    refresh: vi.fn(),
  }),
}))

describe('M3-02 sample field path selection', () => {
  it('keeps paths relative to an already extracted event even when a field repeats the event-root name', async () => {
    const onRowsChange = vi.fn()

    render(
      <MappingWorkspace
        streamId={null}
        streamTitle="CloudTrail"
        connectorLabel="Local fixture"
        sourceType="HTTP_API_POLLING"
        initialRows={[]}
        enrichment={{}}
        eventArrayPath="$.Records"
        eventRootPath="$.event"
        onRowsChange={onRowsChange}
        externalSample={{
          ok: true,
          sourceType: 'HTTP_API_POLLING',
          rawPayload: { Records: [{ event: { event: { foo: 'bar' } } }] },
          treeDocument: { event: { foo: 'bar' } },
          extractedEvents: [{ event: { foo: 'bar' } }],
          unionSchema: null,
          eventArrayPath: '$.Records',
          eventRootPath: '$.event',
          sampleEventIndex: 0,
          message: null,
          recordsLabel: '1 event',
          fetchedAt: '2026-10-14 05:30:00',
        }}
      />,
    )

    const fieldLabel = await screen.findByText('foo')
    const pickButton = fieldLabel.closest('button')
    expect(pickButton).not.toBeNull()
    fireEvent.click(pickButton!)

    await waitFor(() => expect(onRowsChange).toHaveBeenCalled())
    const rows = onRowsChange.mock.calls.at(-1)?.[0]
    expect(rows).toEqual([
      expect.objectContaining({
        sourceJsonPath: '$.event.foo',
        outputField: 'foo',
      }),
    ])
  })
})
