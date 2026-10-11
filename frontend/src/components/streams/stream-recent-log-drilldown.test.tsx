import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { timelineItemsToRecentLogLines } from '../../api/runtimeTimelineAdapter'
import type { RuntimeTimelineItem } from '../../api/types/gdcApi'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

function event(overrides: Partial<RuntimeTimelineItem> = {}): RuntimeTimelineItem {
  return {
    id: 111,
    created_at: '2026-10-11T08:00:00Z',
    stream_id: 42,
    route_id: 17,
    destination_id: 31,
    run_id: 'run-20261011-abc',
    stage: 'route_send_failed',
    status: 'FAILED',
    level: 'ERROR',
    message: 'Receiver timed out',
    error_code: 'CONNECT_TIMEOUT',
    retry_count: 0,
    http_status: null,
    latency_ms: 1000,
    ...overrides,
  }
}

function renderRecentLog(e: RuntimeTimelineItem) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        recentLogs={timelineItemsToRecentLogLines([e])}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
      />
    </MemoryRouter>,
  )
  return screen.getByTestId('stream-recent-events-panel')
}

describe('Stream recent log scoped investigation', () => {
  it('keeps verified Stream, Route, Destination and Run identities in the clicked event', () => {
    const panel = renderRecentLog(event())
    fireEvent.click(screen.getByRole('button', { name: /Recent delivery/ }))
    expect(panel).toHaveTextContent('Receiver timed out')
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/logs?route_id=17&stream_id=42&destination_id=31&run_id=run-20261011-abc',
    )
  })

  it('does not create invalid or unsupported filters from missing Route, Destination, or short Run identity', () => {
    renderRecentLog(event({ route_id: 0, destination_id: null, run_id: 'x' }))
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/logs?stream_id=42')
  })

  it('keeps the existing fallback when the stream has no verified backend numeric ID', () => {
    render(
      <MemoryRouter>
        <StreamRecentEventsPanel
          streamId="some-stream"
          backendStreamId={undefined}
          recentLogs={timelineItemsToRecentLogLines([event()])}
          runHistory={[]}
          logsHref="/logs/some-stream"
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/logs/some-stream')
  })
})
