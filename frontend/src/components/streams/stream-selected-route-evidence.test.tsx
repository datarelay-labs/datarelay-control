import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { RecentLogLine } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const sample = (
  routeId: number,
  stage: string | undefined,
  at: string,
  message: string,
  level: RecentLogLine['level'] = 'INFO',
  destinationId: number | null = routeId === 17 ? 71 : 73,
): RecentLogLine => ({
  routeId, stage, at, message, level, destinationId, duration: '12 ms',
})
const sourceRows: RecentLogLine[] = [
  sample(17, 'route_send_failed', '2026-10-11 09:05 UTC', 'Route 17 failure', 'ERROR'),
  sample(17, 'route_send_success', '2026-10-11 09:04 UTC', 'Gateway record not receiver receipt'),
  sample(17, 'route_retry_failed', '2026-10-11 09:03 UTC', 'Retry failed', 'ERROR'),
  sample(17, undefined, '2026-10-11 09:02 UTC', 'Legacy message delivered', 'INFO', null),
  sample(23, 'route_send_success', '2026-10-11 09:01 UTC', 'Different Route success'),
]

function mount(variant: 'default' | 'compact' = 'default', logs = sourceRows, backendStreamId: number | null = 42) {
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={backendStreamId ?? undefined}
        recentLogs={logs}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
        variant={variant}
      />
    </MemoryRouter>,
  )
  const panel = screen.getByTestId('stream-recent-events-panel')
  const selector = within(panel).getByLabelText('Filter recent events by Route')
  return { panel, selector }
}

describe('Competitor-inspired selected Route operational evidence', () => {
  it('distinguishes recorded gateway successes/failures from receiver acceptance and retains scoped failure investigation', () => {
    const { panel, selector } = mount()
    fireEvent.change(selector, { target: { value: '17' } })
    const evidence = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(evidence).toHaveTextContent('Route #17')
    expect(evidence).toHaveTextContent('4 events in loaded sample')
    expect(evidence).toHaveTextContent('Gateway success records: 1')
    expect(evidence).toHaveTextContent('Gateway failure records: 2')
    expect(evidence).toHaveTextContent('Destination #71')
    expect(evidence).toHaveTextContent('route_send_failed')
    expect(evidence).toHaveTextContent('route_retry_failed')
    expect(evidence).toHaveTextContent('Receiver acknowledgment not verified')
    expect(within(evidence).getByRole('link', { name: 'Inspect recorded Route failures' })).toHaveAttribute(
      'href', '/logs?route_id=17&stream_id=42&status=failed',
    )
    expect(within(panel).getByRole('button', { name: /Recent events \(4\)/ })).toBeInTheDocument()
  })

  it('switches with selected path and never shows another Route failure or synthetic global Run totals', () => {
    const { panel, selector } = mount()
    fireEvent.change(selector, { target: { value: '17' } })
    expect(within(panel).getByRole('link', { name: 'Inspect recorded Route failures' })).toBeInTheDocument()
    fireEvent.change(selector, { target: { value: '23' } })
    const evidence = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(evidence).toHaveTextContent('Route #23')
    expect(evidence).toHaveTextContent('1 events in loaded sample')
    expect(evidence).toHaveTextContent('Gateway success records: 1')
    expect(evidence).toHaveTextContent('Gateway failure records: 0')
    expect(evidence).not.toHaveTextContent('route_send_failed')
    expect(within(evidence).queryByRole('link', { name: 'Inspect recorded Route failures' })).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /Recent events \(1\)/ })).toBeInTheDocument()
  })

  it('never infers success or failure outcomes from legacy text or unrecognized stages', () => {
    const { panel, selector } = mount('default', [
      sample(17, undefined, '2026-10-11 09:01 UTC', 'Successfully delivered everything'),
      sample(17, 'route_waiting', '2026-10-11 09:00 UTC', 'Failed operation'),
    ])
    fireEvent.change(selector, { target: { value: '17' } })
    const evidence = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(evidence).toHaveTextContent('Gateway outcome not verified in this sample')
    expect(evidence).not.toHaveTextContent('Gateway success records: 1')
    expect(within(evidence).queryByRole('link', { name: 'Inspect recorded Route failures' })).not.toBeInTheDocument()
  })

  it('renders the route evidence on compact/mobile without relying on desktop tabs', () => {
    const { panel, selector } = mount('compact')
    fireEvent.change(selector, { target: { value: '17' } })
    const evidence = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(evidence).toHaveTextContent('Gateway failure records: 2')
    expect(within(evidence).getByRole('link', { name: 'Inspect recorded Route failures' })).toHaveAttribute(
      'href', '/logs?route_id=17&stream_id=42&status=failed',
    )
  })

  it('avoids generating a failure link without a verified numeric Stream ID', () => {
    const { panel, selector } = mount('compact', sourceRows, null)
    fireEvent.change(selector, { target: { value: '17' } })
    const evidence = within(panel).getByRole('region', { name: 'Selected Route evidence' })
    expect(evidence).toHaveTextContent('Gateway failure records: 2')
    expect(within(evidence).queryByRole('link', { name: 'Inspect recorded Route failures' })).not.toBeInTheDocument()
  })
})
