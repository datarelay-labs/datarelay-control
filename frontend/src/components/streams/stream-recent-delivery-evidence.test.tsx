import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { RunHistoryRow } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const run = (runId: string, delivered: number, failed: number, status: RunHistoryRow['status']): RunHistoryRow => ({
  runId,
  startedAt: '2026-10-10 09:00 UTC',
  duration: '12 ms',
  status,
  delivered,
  failed,
  events: 1,
})

function renderRuns(runs: RunHistoryRow[]) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        runHistory={runs}
        recentLogs={[]}
        logsHref="/logs?stream_id=42"
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Recent delivery/ }))
}

describe('Stream recent delivery evidence', () => {
  it('does not present a generic successful lifecycle run as a delivery', () => {
    renderRuns([run('unproven-lifecycle', 0, 0, 'Success')])
    const panel = screen.getByTestId('stream-recent-events-panel')
    expect(panel).toHaveTextContent('No recent delivery events in timeline sample.')
    expect(panel).not.toHaveTextContent('unproven-lifecycle')
  })

  it('keeps confirmed successful and failed deliveries available to investigate', () => {
    renderRuns([
      run('unproven-lifecycle', 0, 0, 'Success'),
      run('confirmed-delivery', 2, 0, 'Success'),
      run('failed-delivery', 0, 1, 'Failed'),
    ])
    const panel = screen.getByTestId('stream-recent-events-panel')
    expect(panel).toHaveTextContent('confirmed-delivery')
    expect(panel).toHaveTextContent('failed-delivery')
    expect(panel).not.toHaveTextContent('unproven-lifecycle')
  })
})
