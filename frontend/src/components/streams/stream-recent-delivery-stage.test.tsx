import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'
import type { RecentLogLine } from './stream-runtime-detail-model'

function log(stage: string | undefined, message: string): RecentLogLine {
  return {
    at: '09:00:00 UTC',
    level: 'INFO',
    message,
    stage,
    duration: '12 ms',
  }
}

function renderDelivery(recentLogs: RecentLogLine[]) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        logsHref="/logs?stream_id=42"
        recentLogs={recentLogs}
        runHistory={[]}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Recent delivery/ }))
  return screen.getByTestId('stream-recent-events-panel')
}

describe('Stream delivery log stage authority', () => {
  it('excludes unrelated Source send text when an authoritative source stage is present', () => {
    const panel = renderDelivery([
      log('source_fetch', 'Send an HTTP request to the Source'),
      log('route_send_failed', 'Remote endpoint connection reset'),
    ])
    expect(panel).toHaveTextContent('Remote endpoint connection reset')
    expect(panel).not.toHaveTextContent('Send an HTTP request to the Source')
  })

  it('includes a recorded Route success despite generic message text', () => {
    const panel = renderDelivery([log('route_retry_success', 'Recovered on retry')])
    expect(panel).toHaveTextContent('Recovered on retry')
    expect(panel).not.toHaveTextContent('No recent delivery events in timeline sample.')
  })

  it('keeps message fallback for legacy logs missing the stage contract', () => {
    const panel = renderDelivery([log(undefined, 'Route delivered to receiver')])
    expect(panel).toHaveTextContent('Route delivered to receiver')
  })
})
