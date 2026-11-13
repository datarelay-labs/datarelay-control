import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { streamReadToConsoleRow, type StreamConsoleRow } from '../../api/streamRows'
import { StreamConsoleDetailPanel, type DetailTab } from './stream-console-detail-panel'

function baseRow(overrides: Partial<StreamConsoleRow> = {}): StreamConsoleRow {
  return {
    ...streamReadToConsoleRow({
      id: 1,
      name: 'Test Stream',
      status: 'RUNNING',
      source_type: 'HTTP_API_POLLING',
      stream_type: null,
      source_id: null,
      connector_id: null,
      polling_interval: 60,
      created_at: '2026-01-01T00:00:00',
      config_json: {},
    }),
    ...overrides,
  }
}

function mount(stream: StreamConsoleRow, initialTab: DetailTab = 'overview') {
  return render(
    <MemoryRouter>
      <StreamConsoleDetailPanel stream={stream} routes={[]} problems={[]} onClose={() => {}} initialTab={initialTab} />
    </MemoryRouter>,
  )
}

describe('StreamConsoleDetailPanel health semantics', () => {
  it('does not label a RUNNING stream Healthy when its snapshot has no verdict (IDLE)', () => {
    mount(baseRow({ status: 'RUNNING', operationalHealthStatus: 'IDLE', hasRuntimeApiSnapshot: true }))
    const panel = screen.getByTestId('stream-console-detail-panel')
    expect(panel).toHaveTextContent('Not verified')
    expect(panel).not.toHaveTextContent(/\bHealthy\b/)
  })

  it('labels a RUNNING stream Healthy only with a healthy verdict and measured delivery', () => {
    mount(
      baseRow({
        status: 'RUNNING',
        operationalHealthStatus: 'HEALTHY',
        hasRuntimeApiSnapshot: true,
        deliveryPctKnown: true,
        deliveryPct: 100,
      }),
    )
    expect(screen.getByTestId('stream-console-detail-panel')).toHaveTextContent('Healthy')
    expect(screen.getByTestId('stream-console-detail-panel')).not.toHaveTextContent('Not verified')
  })

  it('shows Last Checkpoint as Not observed yet instead of Healthy when no checkpoint was observed', () => {
    mount(baseRow({ checkpointUpdatedAt: '—', checkpointValue: '—', checkpointLagLabel: '—' }))
    expect(screen.getByTestId('stream-console-detail-panel')).toHaveTextContent('Not observed yet')
  })

  it('reports the Checkpoint tab status as Not observed yet (never Healthy) without a checkpoint', () => {
    mount(
      baseRow({ checkpointUpdatedAt: '—', checkpointValue: '—', checkpointLagLabel: '—' }),
      'checkpoint',
    )
    const panel = screen.getByTestId('stream-console-detail-panel')
    expect(panel).toHaveTextContent('Not observed yet')
    expect(panel).not.toHaveTextContent(/Status\s*Healthy/)
  })
})
