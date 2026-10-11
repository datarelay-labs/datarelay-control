import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'
import type { RecentLogLine, RunHistoryRow } from './stream-runtime-detail-model'

const line = (routeId: number | null, message: string, level: RecentLogLine['level'] = 'INFO'): RecentLogLine => ({
  at: '2026-10-11 09:00 UTC',
  routeId,
  level,
  message,
  stage: 'route_send_success',
  destinationId: routeId === 17 ? 71 : routeId === 23 ? 73 : null,
  runId: routeId === 17 ? 'run-route-17' : routeId === 23 ? 'run-route-23' : null,
  duration: '10 ms',
})

const recentLogs = [
  line(17, 'route 17 scoped delivery'),
  line(23, 'route 23 scoped delivery', 'ERROR'),
  line(null, 'source-only event'),
  line(0, 'unknown route identity'),
]

const aggregateRun: RunHistoryRow = {
  runId: 'run-aggregation',
  startedAt: '2026-10-11 09:00 UTC',
  duration: '11 ms',
  status: 'Success',
  events: 11,
  delivered: 7,
  failed: 0,
}

function mount(variant: 'compact' | 'default' = 'default', rows = recentLogs) {
  const result = render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        recentLogs={rows}
        runHistory={[aggregateRun]}
        logsHref="/logs?stream_id=42"
        variant={variant}
      />
    </MemoryRouter>,
  )
  return { panel: screen.getByTestId('stream-recent-events-panel'), ...result }
}

describe('Stream Recent Events: selected-Route sample inspection', () => {
  it('filters a loaded sample by an actual Route ID, without inventing all-history coverage', () => {
    const { panel } = mount()
    expect(within(panel).getByLabelText('Filter recent events by Route')).toBeInTheDocument()
    expect(within(panel).queryByRole('option', { name: 'Route #0' })).not.toBeInTheDocument()
    fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '17' } })
    expect(panel).toHaveTextContent('route 17 scoped delivery')
    expect(panel).not.toHaveTextContent('route 23 scoped delivery')
    expect(panel).not.toHaveTextContent('source-only event')
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute('href', '/logs?route_id=17&stream_id=42')
    expect(panel).toHaveTextContent('Recent timeline sample only')
  })

  it('keeps the selected Route in errors/delivery tabs and never includes unscoped run totals', () => {
    const { panel } = mount()
    const filter = within(panel).getByLabelText('Filter recent events by Route')
    fireEvent.change(filter, { target: { value: '23' } })
    fireEvent.click(within(panel).getByRole('button', { name: /Recent errors/ }))
    expect(panel).toHaveTextContent('route 23 scoped delivery')
    expect(panel).not.toHaveTextContent('route 17 scoped delivery')
    fireEvent.click(within(panel).getByRole('button', { name: /Recent delivery/ }))
    expect(panel).toHaveTextContent('route 23 scoped delivery')
    expect(panel).not.toHaveTextContent('run-aggregation')
  })

  it('provides the same scoped Route inspection on compact and narrow screen markup', () => {
    const { panel } = mount('compact')
    fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '17' } })
    expect(panel).toHaveTextContent('route 17 scoped delivery')
    expect(panel).not.toHaveTextContent('route 23 scoped delivery')
    expect(within(panel).getByRole('link', { name: 'View all →' })).toHaveAttribute('href', '/logs?route_id=17&stream_id=42')
    expect(panel).toHaveTextContent('Recent timeline sample only')
  })

  it('reverts to all observed Routes when refresh no longer contains the selected ID', () => {
    const { panel, rerender } = mount()
    fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '17' } })
    rerender(
      <MemoryRouter>
        <StreamRecentEventsPanel
          streamId="42"
          backendStreamId={42}
          recentLogs={[line(23, 'fresh route 23 only')]}
          runHistory={[]}
          logsHref="/logs?stream_id=42"
        />
      </MemoryRouter>,
    )
    expect(within(panel).getByLabelText('Filter recent events by Route')).toHaveValue('all')
    expect(panel).toHaveTextContent('fresh route 23 only')
  })

  it('does not offer a fabricated route scope when the timeline has no numeric route evidence', () => {
    const { panel } = mount('default', [line(null, 'source-only event')])
    expect(within(panel).queryByLabelText('Filter recent events by Route')).not.toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute('href', '/logs?stream_id=42')
  })
})
