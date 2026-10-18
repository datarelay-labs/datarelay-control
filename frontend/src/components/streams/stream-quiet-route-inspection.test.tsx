import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { RecentLogLine } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const actualTimeline: RecentLogLine[] = [{
  at: '2026-10-11 10:00 UTC',
  level: 'INFO',
  message: 'Route 17 accepted gateway batch',
  stage: 'route_send_success',
  routeId: 17,
  duration: '11 ms',
}]

function mount(variant: 'compact' | 'default', recentLogs: RecentLogLine[], observedRouteIds: number[]) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        recentLogs={recentLogs}
        observedRouteIds={observedRouteIds}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
        variant={variant}
      />
    </MemoryRouter>,
  )
  return screen.getByTestId('stream-recent-events-panel')
}

describe('Quiet Route investigation from already-loaded runtime Metrics', () => {
  it('offers Metrics-reported Route IDs even when no event for the Route is in the recent sample', () => {
    const panel = mount('default', actualTimeline, [29])
    const selector = within(panel).getByLabelText('Filter recent events by Route')
    expect(within(selector).getByRole('option', { name: 'Route #17' })).toBeInTheDocument()
    expect(within(selector).getByRole('option', { name: 'Route #29' })).toBeInTheDocument()
    fireEvent.change(selector, { target: { value: '29' } })
    const summary = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(summary).toHaveTextContent('Route #29')
    expect(summary).toHaveTextContent('0 events in loaded sample')
    expect(summary).toHaveTextContent('Gateway outcome not verified in this sample')
    expect(within(panel).getByText(/No events for Route #29 in this timeline sample/)).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute(
      'href', '/logs?route_id=29&stream_id=42',
    )
    expect(within(summary).queryByRole('link', { name: 'Inspect recorded Route failures' })).not.toBeInTheDocument()
  })

  it('offers exactly scoped recovery to Logs in compact layout without treating silence as healthy', () => {
    const panel = mount('compact', [], [29])
    fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), { target: { value: '29' } })
    const summary = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(summary).toHaveTextContent('0 events in loaded sample')
    expect(within(panel).getByText(/No Route #29 events in this timeline sample/)).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'View all →' })).toHaveAttribute(
      'href', '/logs?route_id=29&stream_id=42',
    )
  })

  it('never offers invalid or unverified Metrics-only IDs as selectable Routes', () => {
    const panel = mount('default', [], [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(within(panel).queryByLabelText('Filter recent events by Route')).not.toBeInTheDocument()
    expect(within(panel).queryByRole('region', { name: 'Selected Route evidence' })).not.toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'View all logs' })).toHaveAttribute(
      'href', '/logs?stream_id=42',
    )
  })
})
