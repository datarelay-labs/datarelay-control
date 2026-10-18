import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { setDisplayTimezoneCache } from '../../lib/display-timezone-cache'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

afterEach(() => setDisplayTimezoneCache({ userTimezone: null, platformDefaultTimezone: null }))

function mount({
  generatedAt = '2026-10-11T04:30:00Z' as string | null,
  windowSeconds = 3600 as number | null,
  basis = 'last-hour' as 'last-hour' | 'legacy-aggregate',
  variant = 'default' as 'default' | 'compact',
} = {}) {
  setDisplayTimezoneCache({ userTimezone: 'Asia/Seoul' })
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        recentLogs={[]}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
        variant={variant}
        observedRouteIds={[29]}
        routeMetrics={[{ routeId: 29, enabled: false, failedCount: 3, destinationName: 'SIEM' }]}
        metricsGeneratedAt={generatedAt}
        metricsWindowSeconds={windowSeconds}
        failureCountBasis={basis}
      />
    </MemoryRouter>,
  )
  const root = screen.getByTestId('stream-recent-events-panel')
  fireEvent.change(within(root).getByLabelText('Filter recent events by Route'), { target: { value: '29' } })
  return within(root).getByRole('region', { name: 'Selected Route evidence' })
}

describe('Selected Route metrics provenance', () => {
  it('shows actual source timestamp in selected user timezone and the API-requested window', () => {
    const evidence = mount()
    expect(evidence).toHaveTextContent('Metrics snapshot observed: 2026-10-11 13:30')
    expect(evidence).toHaveTextContent('Metrics requested window: 1h')
    expect(evidence).toHaveTextContent('Metrics-reported failed attempts (last hour): 3')
    expect(evidence).not.toHaveTextContent('Live now')
  })

  it('uses an explicit unknown when the timestamp or aggregation window is not verified', () => {
    const evidence = mount({ generatedAt: 'not-a-valid-timestamp', windowSeconds: null, variant: 'compact' })
    expect(evidence).toHaveTextContent('Metrics observation time not verified')
    expect(evidence).toHaveTextContent('Metrics window not verified')
    expect(evidence).not.toHaveTextContent('not-a-valid-timestamp')
    expect(evidence).not.toHaveTextContent('Live now')
  })

  it('does not mislabel legacy failed_count as a confirmed last-hour count', () => {
    const evidence = mount({ basis: 'legacy-aggregate', windowSeconds: 86400 })
    expect(evidence).toHaveTextContent('Metrics-reported failed attempts: 3')
    expect(evidence).toHaveTextContent('Metrics requested window: 24h')
    expect(evidence).not.toHaveTextContent('Metrics-reported failed attempts (last hour)')
  })
})
