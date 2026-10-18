import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { LogDetailDrawer } from './log-detail-drawer'
import type { LogExplorerRow } from './logs-types'

vi.mock('../../api/gdcRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../api/gdcRuntime')>('../../api/gdcRuntime')
  return {
    ...actual,
    fetchCheckpointTrace: vi.fn(async () => null),
    fetchRuntimeLogTrace: vi.fn(async () => null),
    replayDeliveryLog: vi.fn(),
  }
})

function row(stage: string, extra: Record<string, unknown> = {}): LogExplorerRow {
  return {
    id: 'log-1',
    eventId: 'evt-1',
    timeIso: '2026-10-14T11:00:00.000Z',
    level: stage === 'route_send_failed' ? 'ERROR' : 'WARN',
    connector: 'Connector #1',
    stream: 'Stream #2',
    route: 'Route #42',
    message: 'synthetic outcome',
    durationMs: 4,
    contextJson: {
      stage,
      status: stage === 'policy_blocked' ? 'BLOCKED' : 'OK',
      stream_id: 2,
      route_id: 42,
      destination_id: 10,
      decision_reason: 'PII policy matched',
      ...extra,
    },
    relatedEventId: null,
  }
}

function mount(candidate: LogExplorerRow) {
  return render(
    <MemoryRouter>
      <LogDetailDrawer row={candidate} onClose={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('LogDetailDrawer governance outcome context', () => {
  it('explains a policy block as governance rather than a receiver delivery failure', () => {
    mount(row('policy_blocked'))
    const context = screen.getByTestId('log-detail-governance-context')
    expect(context).toHaveTextContent(/not a receiver delivery failure/i)
    expect(context).toHaveTextContent(/PII policy matched/i)
    expect(screen.getByTestId('log-detail-governance-action')).toHaveAttribute(
      'href',
      '/governance/workspace?stream_id=2&route_id=42',
    )
    expect(screen.queryByTestId('log-detail-replay-panel')).not.toBeInTheDocument()
  })

  it('opens the exact quarantine event when the runtime row provides its real id', () => {
    mount(row('quarantine_event_created', { quarantine_event_id: 55, status: 'QUARANTINED' }))
    expect(screen.getByTestId('log-detail-governance-context')).toHaveTextContent(/routed to quarantine/i)
    expect(screen.getByTestId('log-detail-governance-action')).toHaveAttribute(
      'href',
      '/governance/quarantine?id=55',
    )
  })

  it('uses Governance workspace for review-required outcomes without inventing an approval id', () => {
    mount(row('policy_review_required', { status: 'REVIEW_REQUIRED' }))
    expect(screen.getByTestId('log-detail-governance-context')).toHaveTextContent(/waiting on a governance review/i)
    expect(screen.getByTestId('log-detail-governance-action')).toHaveAttribute(
      'href',
      '/governance/workspace?stream_id=2&route_id=42',
    )
  })

  it('keeps a real destination send failure on the delivery recovery path', () => {
    mount(row('route_send_failed', { status: 'FAILED' }))
    expect(screen.queryByTestId('log-detail-governance-context')).not.toBeInTheDocument()
    expect(screen.getByTestId('log-detail-open-runtime')).toBeInTheDocument()
  })
})
