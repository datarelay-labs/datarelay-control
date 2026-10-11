import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { RecentLogLine } from './stream-runtime-detail-model'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

function renderSingle(stage: string | undefined, message: string, level: RecentLogLine['level'] = 'INFO') {
  const record: RecentLogLine = {
    at: '2026-10-11 10:00 UTC',
    level,
    stage,
    routeId: 17,
    message,
    duration: '11 ms',
  }
  render(
    <MemoryRouter>
      <StreamRecentEventsPanel
        streamId="42"
        backendStreamId={42}
        recentLogs={[record]}
        runHistory={[]}
        logsHref="/logs?stream_id=42"
        variant="compact"
      />
    </MemoryRouter>,
  )
  const panel = screen.getByTestId('stream-recent-events-panel')
  const event = within(panel).getByRole('listitem')
  return event.querySelector('svg')
}

describe('Mobile Stream event indicator requires runtime stage proof', () => {
  it('never shows a green gateway success icon for stage-less success-sounding text', () => {
    const icon = renderSingle(undefined, 'Successfully delivered to receiver')
    expect(icon).toHaveClass('lucide-info')
    expect(icon).not.toHaveClass('text-emerald-500')
  })

  it('shows a success icon only for a recognized gateway success stage, independent of wording', () => {
    const icon = renderSingle('route_send_success', 'Gateway wrote batch to transport')
    expect(icon).toHaveClass('lucide-check-circle-2')
  })

  it('shows an alert for a recorded failure stage even when the level is mistakenly INFO', () => {
    const icon = renderSingle('route_send_failed', 'Remote handshake ended')
    expect(icon).toHaveClass('lucide-alert-triangle')
  })
})
