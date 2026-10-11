import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'
import type { RecentLogLine } from './stream-runtime-detail-model'

function log(routeId: number): RecentLogLine {
  return {
    at: '2026-10-11 13:00 UTC',
    routeId,
    destinationId: routeId + 100,
    stage: 'route_send_success',
    level: 'INFO',
    message: `Route ${routeId} observed gateway send`,
    duration: '10ms',
  }
}
function view(ids: number[], numericStreamId: number | undefined = 42) {
  return (
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={numericStreamId}
        recentLogs={ids.map(log)}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
      />
    </MemoryRouter>
  )
}

describe('Route selection lifecycle and fail-closed Logs navigation', () => {
  it('does not resurrect a disappeared Route when later timeline refreshes include it again', () => {
    const { rerender } = render(view([17, 23]))
    const panel = screen.getByTestId('stream-recent-events-panel')
    fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '17' } })
    expect(within(panel).getByLabelText('Filter recent events by Route')).toHaveValue('17')

    rerender(view([23]))
    expect(within(panel).getByLabelText('Filter recent events by Route')).toHaveValue('all')
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute('href', '/logs?stream_id=42')

    rerender(view([17, 23]))
    expect(within(panel).getByLabelText('Filter recent events by Route')).toHaveValue('all')
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute('href', '/logs?stream_id=42')
    expect(panel).toHaveTextContent('Route 23 observed gateway send')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'does not claim a scoped Logs link when the Stream ID is not a valid positive safe integer (%s)',
    (id) => {
      render(view([17], id))
      const panel = screen.getByTestId('stream-recent-events-panel')
      fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '17' } })
      expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute('href', '/logs')
    },
  )

  it('keeps a valid Stream and Route scope after selecting a different observed path', () => {
    render(view([17, 23]))
    const panel = screen.getByTestId('stream-recent-events-panel')
    fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '23' } })
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute(
      'href', '/logs?route_id=23&stream_id=42',
    )
  })
})
