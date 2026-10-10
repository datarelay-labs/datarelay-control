import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LogExplorerRow } from './logs-types'
import { LogsCompactCards } from './logs-compact-cards'

const row: LogExplorerRow = {
  id: '72',
  eventId: 'evt_72',
  timeIso: '2026-10-10T09:00:00Z',
  level: 'ERROR',
  connector: 'Payment API',
  stream: 'Payment Stream',
  route: 'Payment Route → SIEM receiver',
  message: 'Delivery attempt failed on route 42',
  durationMs: 30,
  contextJson: { stage: 'syslog_send', status: 'FAILED', destination_id: 10, retry_count: 2 },
  relatedEventId: null,
}

describe('Logs Explorer narrow-screen compact investigation', () => {
  it('keeps current-page delivery truth and opens the existing detail for a selected log', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <LogsCompactCards
        rows={[row]} loading={false} apiUnavailable={false}
        selectedId={null} onSelect={onSelect} onClearFilters={vi.fn()}
      />,
    )
    const panel = screen.getByRole('region', { name: 'Compact delivery logs' })
    expect(panel).toHaveTextContent('Delivery attempt failed on route 42')
    expect(panel).toHaveTextContent('FAILED')
    expect(panel).toHaveTextContent('SYSLOG_SEND')
    expect(panel).toHaveTextContent('Payment Stream')
    expect(panel).toHaveTextContent('Payment Route')
    const action = screen.getByRole('button', { name: 'Inspect log evt_72' })
    expect(action).toHaveAttribute('aria-pressed', 'false')
    await user.click(action)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('72')
  })

  it('does not invent a clean empty installation on API failure', () => {
    const onClearFilters = vi.fn()
    render(
      <LogsCompactCards
        rows={[]} loading={false} apiUnavailable
        selectedId={null} onSelect={vi.fn()} onClearFilters={onClearFilters}
      />,
    )
    const panel = screen.getByRole('region', { name: 'Compact delivery logs' })
    expect(panel).toHaveTextContent('Runtime logs API failed')
    expect(panel).not.toHaveTextContent('No delivery issues')
  })

  it('shows a loading state and accessible recovery action for an empty filter', async () => {
    const onClearFilters = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <LogsCompactCards
        rows={[]} loading apiUnavailable={false}
        selectedId={null} onSelect={vi.fn()} onClearFilters={onClearFilters}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading logs')
    rerender(
      <LogsCompactCards
        rows={[]} loading={false} apiUnavailable={false}
        selectedId={null} onSelect={vi.fn()} onClearFilters={onClearFilters}
      />,
    )
    expect(screen.getByRole('region', { name: 'Compact delivery logs' })).toHaveTextContent('No logs match')
    await user.click(screen.getByRole('button', { name: 'Clear log filters' }))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })
})
