import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { RecentLogLine } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const timeline: RecentLogLine[] = [{
  at: '2026-10-11 13:00 UTC',
  level: 'ERROR',
  stage: 'route_send_failed',
  message: 'Observed Route 17 gateway failure',
  routeId: 17,
  destinationId: 71,
  duration: '18 ms',
}]

const metrics = [
  { routeId: 17, enabled: true, failedCount: 1, destinationName: '  Finance Sink  ' },
  { routeId: 29, enabled: false, failedCount: 2, destinationName: 'SIEM Archive' },
  { routeId: 31, enabled: true, failedCount: 0, destinationName: '' },
]

function mount(
  variant: 'default' | 'compact' = 'default',
  rows = timeline,
  measuredRoutes = metrics,
  observedRouteIds = [17, 29, 31],
) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        recentLogs={rows}
        runHistory={[]}
        observedRouteIds={observedRouteIds}
        routeMetrics={measuredRoutes}
        logsHref="/logs?stream_id=42"
        variant={variant}
      />
    </MemoryRouter>,
  )
  const panel = screen.getByTestId('stream-recent-events-panel')
  return { panel, selector: within(panel).getByLabelText('Filter recent events by Route') }
}

describe('Destination-aware Route selection for multi-path Stream diagnostics', () => {
  it('groups actual timeline Routes separately from quieter Metrics-known Routes', () => {
    const { selector } = mount()
    const groups = selector.querySelectorAll('optgroup')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveAttribute('label', 'Routes in recent timeline')
    expect(groups[1]).toHaveAttribute('label', 'Other Routes in loaded Metrics')
    expect(within(groups[0]!).getByRole('option', {
      name: 'Route #17 — Finance Sink · last reported Enabled',
    })).toHaveValue('17')
    expect(within(groups[1]!).getByRole('option', {
      name: 'Route #29 — SIEM Archive · last reported Disabled',
    })).toHaveValue('29')
    expect(within(groups[1]!).getByRole('option', { name: 'Route #31 · last reported Enabled' })).toHaveValue('31')
    expect(within(selector).getByRole('option', { name: 'All recent events' })).toHaveValue('all')
    expect(within(selector).getAllByRole('option')).toHaveLength(4)
  })

  it('allows quiet route investigation by human-meaningful Destination, retaining the exact ID', () => {
    const { panel, selector } = mount()
    fireEvent.change(selector, { target: { value: '29' } })
    expect(within(panel).getByRole('region', { name: 'Selected Route evidence' })).toHaveTextContent('Destination SIEM Archive')
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute(
      'href', '/logs?route_id=29&stream_id=42',
    )
    expect(within(panel).getByRole('region', { name: 'Selected Route evidence' })).toHaveTextContent('0 events in loaded sample')
  })

  it('keeps compact/mobile selected-path labels and scope without introducing a mouse-only picker', () => {
    const { panel, selector } = mount('compact')
    expect(selector).toHaveAttribute('aria-label', 'Filter recent events by Route')
    expect(within(selector).getByRole('option', { name: /Route #29.*SIEM Archive/ })).toBeInTheDocument()
    fireEvent.change(selector, { target: { value: '29' } })
    expect(within(panel).getByRole('link', { name: 'View all →' })).toHaveAttribute(
      'href', '/logs?route_id=29&stream_id=42',
    )
    fireEvent.change(selector, { target: { value: 'all' } })
    expect(within(panel).getByText('Observed Route 17 gateway failure')).toBeInTheDocument()
  })

  it('distinguishes timeline-only Route identity from unverified destination and status', () => {
    const { selector } = mount('default', timeline, [], [])
    const groups = selector.querySelectorAll('optgroup')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveAttribute('label', 'Routes in recent timeline')
    expect(within(selector).getByRole('option', { name: 'Route #17' })).toBeInTheDocument()
    expect(selector).not.toHaveTextContent('last reported Disabled')
  })

  it('never invents a disabled-state label when Metrics has malformed enablement', () => {
    const invalidEnablement = [
      { routeId: 29, enabled: null as unknown as boolean, failedCount: 0, destinationName: 'SIEM Archive' },
    ]
    const { selector } = mount('default', [], invalidEnablement, [29, 0, -2, Number.NaN])
    const opts = within(selector).getAllByRole('option')
    expect(opts).toHaveLength(2)
    expect(opts[1]).toHaveTextContent('Route #29 — SIEM Archive')
    expect(opts[1]).not.toHaveTextContent('Disabled')
    expect(opts[1]).not.toHaveTextContent('Enabled')
  })
})
