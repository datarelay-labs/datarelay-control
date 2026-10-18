import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { RecentLogLine } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const runtimeRecords: RecentLogLine[] = [
  {
    routeId: 17,
    destinationId: 71,
    stage: 'route_send_failed',
    level: 'ERROR',
    message: 'Gateway delivery timed out',
    at: '2026-10-11 10:00 UTC',
    duration: '10ms',
  },
  {
    routeId: 23,
    destinationId: 73,
    stage: 'route_send_success',
    level: 'INFO',
    message: 'Route 23 recorded gateway success',
    at: '2026-10-11 09:59 UTC',
    duration: '20ms',
  },
]

function renderCard({
  variant = 'default',
  numericStreamId = 42 as number | null,
  recentLogs = runtimeRecords,
  metricsKnownRouteIds = [29],
}: {
  variant?: 'default' | 'compact'
  numericStreamId?: number | null
  recentLogs?: RecentLogLine[]
  metricsKnownRouteIds?: number[]
} = {}) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={numericStreamId ?? undefined}
        recentLogs={recentLogs}
        observedRouteIds={metricsKnownRouteIds}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
        variant={variant}
      />
    </MemoryRouter>,
  )
  const card = screen.getByTestId('stream-recent-events-panel')
  return { card, select: within(card).getByLabelText('Filter recent events by Route') }
}

describe('Selected path to retained Route analytics', () => {
  it('opens existing Analytics with exact real Route and Stream identities and an explicit 24h time window', () => {
    const { card, select } = renderCard()
    fireEvent.change(select, { target: { value: '17' } })
    const evidence = within(card).getByRole('region', { name: 'Selected Route evidence' })
    expect(within(evidence).getByRole('link', { name: 'Analyze Route failure trend (24h)' })).toHaveAttribute(
      'href', '/monitoring/analytics?window=24h&stream_id=42&route_id=17',
    )
    expect(evidence).toHaveTextContent('Historical Analytics is loaded separately; this is a recent timeline sample.')
  })

  it('keeps quiet Metrics-only Routes analyzable without inventing Timeline evidence', () => {
    const { card, select } = renderCard({ recentLogs: [] })
    fireEvent.change(select, { target: { value: '29' } })
    const evidence = within(card).getByRole('region', { name: 'Selected Route evidence' })
    expect(evidence).toHaveTextContent('0 events in loaded sample')
    expect(within(evidence).getByRole('link', { name: 'Analyze Route failure trend (24h)' })).toHaveAttribute(
      'href', '/monitoring/analytics?window=24h&stream_id=42&route_id=29',
    )
    expect(evidence).not.toHaveTextContent('Gateway failure records: 1')
  })

  it('retains exact Route scope on compact/mobile when a different Route is selected', () => {
    const { card, select } = renderCard({ variant: 'compact' })
    fireEvent.change(select, { target: { value: '17' } })
    const link = within(card).getByRole('link', { name: 'Analyze Route failure trend (24h)' })
    expect(link).toHaveAttribute('href', '/monitoring/analytics?window=24h&stream_id=42&route_id=17')
    fireEvent.change(select, { target: { value: '23' } })
    expect(link).toHaveAttribute('href', '/monitoring/analytics?window=24h&stream_id=42&route_id=23')
  })

  it('never links to unscoped Analytics if the numeric Stream identity is unknown', () => {
    const { card, select } = renderCard({ numericStreamId: null })
    fireEvent.change(select, { target: { value: '17' } })
    const evidence = within(card).getByRole('region', { name: 'Selected Route evidence' })
    expect(within(evidence).queryByRole('link', { name: 'Analyze Route failure trend (24h)' })).not.toBeInTheDocument()
  })

  it('never offers a fake Route analytic action for invalid or absent Route identities', () => {
    render(
      <MemoryRouter>
        <StreamRecentEventsPanel
          streamId="42"
          backendStreamId={42}
          recentLogs={[]}
          observedRouteIds={[0, -2, Number.NaN]}
          runHistory={[]}
          logsHref="/logs?stream_id=42"
        />
      </MemoryRouter>,
    )
    const card = screen.getByTestId('stream-recent-events-panel')
    expect(within(card).queryByLabelText('Filter recent events by Route')).not.toBeInTheDocument()
    expect(within(card).queryByRole('region', { name: 'Selected Route evidence' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: 'Analyze Route failure trend (24h)' })).not.toBeInTheDocument()
  })
})
