import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { RecentLogLine } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const quietRoute = [{
  routeId: 29,
  enabled: false,
  failedCount: 3,
  destinationName: 'SIEM Receiver',
}]
const historicalError: RecentLogLine = {
  at: '2026-10-11 09:00 UTC',
  level: 'ERROR',
  message: 'Observed transport error',
  stage: 'route_send_failed',
  routeId: 17,
  duration: '25 ms',
}
function showRoute({
  variant = 'default',
  recentLogs = [] as RecentLogLine[],
  observedRouteIds = [29],
  metrics = quietRoute,
  backendStreamId = 42 as number | null,
} = {}) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={backendStreamId ?? undefined}
        recentLogs={recentLogs}
        observedRouteIds={observedRouteIds}
        routeMetrics={metrics}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
        variant={variant}
      />
    </MemoryRouter>,
  )
  const panel = screen.getByTestId('stream-recent-events-panel')
  fireEvent.change(within(panel).getByLabelText('Filter recent events by Route'), {
    target: { value: '29' },
  })
  return within(panel).getByRole('region', { name: 'Selected Route evidence' })
}

describe('Quiet Route path Metrics evidence versus runtime timeline', () => {
  it('keeps Metrics-reported Disabled and failures distinct from missing latest timeline outcomes', () => {
    const card = showRoute()
    expect(card).toHaveTextContent('0 events in loaded sample')
    expect(card).toHaveTextContent('Gateway outcome not verified in this sample')
    expect(card).toHaveTextContent('Last reported Route state: Disabled')
    expect(card).toHaveTextContent('Metrics-reported failed attempts: 3')
    expect(card).toHaveTextContent('Destination SIEM Receiver')
    expect(card).toHaveTextContent('Metrics is not proof of current receiver acknowledgment')
    expect(within(card).getByRole('link', { name: 'Inspect recorded Route failures' })).toHaveAttribute(
      'href', '/logs?route_id=29&stream_id=42&status=failed',
    )
    expect(card).not.toHaveTextContent('Gateway failure records: 3')
  })

  it('does not infer Healthy or create failure links for a last-reported Enabled quiet Route with zero failures', () => {
    const card = showRoute({
      metrics: [{ routeId: 29, enabled: true, failedCount: 0, destinationName: 'Receiver' }],
    })
    expect(card).toHaveTextContent('Last reported Route state: Enabled')
    expect(card).toHaveTextContent('Metrics-reported failed attempts: 0')
    expect(card).not.toHaveTextContent('Healthy')
    expect(within(card).queryByRole('link', { name: 'Inspect recorded Route failures' })).not.toBeInTheDocument()
  })

  it('only preserves an actual timeline failure link when Metrics failure counters are unverified', () => {
    const card = showRoute({
      recentLogs: [{ ...historicalError, routeId: 29 }],
      metrics: [{ routeId: 29, enabled: true, failedCount: Number.NaN, destinationName: '' }],
    })
    expect(card).toHaveTextContent('Gateway failure records: 1')
    expect(card).not.toHaveTextContent('Metrics-reported failed attempts: NaN')
    expect(within(card).getByRole('link', { name: 'Inspect recorded Route failures' })).toBeInTheDocument()
  })

  it('does not generate an exact Logs link if the backend Stream numeric identity is unknown', () => {
    const card = showRoute({ variant: 'compact', backendStreamId: null })
    expect(card).toHaveTextContent('Metrics-reported failed attempts: 3')
    expect(within(card).queryByRole('link', { name: 'Inspect recorded Route failures' })).not.toBeInTheDocument()
  })
})
