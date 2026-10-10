import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { RuntimeLogSearchItem } from '../../api/types/gdcApi'
import { mapLogToDeliveryActivity, mapLogToRecentFailure } from './destination-runtime-metrics'
import { DeliveryActivityTable, RecentFailuresList } from './destination-detail-page'

const routeLabels = new Map([[42, 'Route #42']])
function evidence(patch: Partial<RuntimeLogSearchItem> = {}): RuntimeLogSearchItem {
  return {
    id: 701, connector_id: null, stream_id: 2, route_id: 42,
    destination_id: 10, run_id: null, stage: 'webhook_send',
    level: 'INFO', status: 'OK', message: 'Delivery outcome recorded',
    retry_count: 0, http_status: null, latency_ms: 13.7,
    error_code: null, created_at: '2026-10-11T00:00:00Z',
    ...patch,
  }
}
function showLog(log: RuntimeLogSearchItem, destinationId = 10, failuresOnly = false) {
  return render(
    <MemoryRouter>
      <DeliveryActivityTable
        rows={[mapLogToDeliveryActivity(log, routeLabels)]}
        destinationId={destinationId}
        emptyMessage="No verified delivery entries"
        failuresOnly={failuresOnly}
      />
    </MemoryRouter>,
  )
}

describe('Destination delivery evidence integrity', () => {
  it('never presents a missing or unrecognized outcome as delivered or unmeasured latency as zero', () => {
    const row = mapLogToDeliveryActivity(evidence({ status: null, latency_ms: null, retry_count: 0 }), routeLabels)
    expect(row.status).toBe('UNKNOWN')
    expect(row.latencyMs).toBeNull()
    expect(mapLogToDeliveryActivity(evidence({ status: 'PENDING' }), routeLabels).status).toBe('UNKNOWN')
    const view = showLog(evidence({ status: null, latency_ms: null }))
    const table = within(view.container).getByRole('table')
    expect(within(table).getByText('UNKNOWN')).toBeInTheDocument()
    expect(within(table).queryByText('0 ms')).not.toBeInTheDocument()
    expect(within(table).getByText('—')).toBeInTheDocument()
  })

  it('does not call a confirmed OK delivery a retry failure just because attempts preceded success', () => {
    const row = mapLogToDeliveryActivity(evidence({ status: 'OK', retry_count: 2 }), routeLabels)
    expect(row.status).toBe('SUCCESS')
    expect(row.latencyMs).toBe(14)
  })

  it('never attributes an unknown or missing failure code to a fabricated TIMEOUT', () => {
    expect(mapLogToRecentFailure(evidence({ status: 'FAILED', level: 'ERROR', error_code: null }), routeLabels).code)
      .toBe('UNCLASSIFIED')
    expect(mapLogToRecentFailure(evidence({ status: 'FAILED', level: 'ERROR', error_code: 'secret_token_abc' }), routeLabels).code)
      .toBe('UNCLASSIFIED')
    expect(mapLogToRecentFailure(evidence({ status: 'FAILED', level: 'ERROR', error_code: 'RATE_LIMIT' }), routeLabels).code)
      .toBe('RATE_LIMIT')
  })

  it('links a delivery event row to the actual Route, Stream and Destination IDs, without implying failed-only scope', () => {
    showLog(evidence())
    const link = screen.getByRole('link', { name: 'Investigate Route #42 delivery logs' })
    expect(link).toHaveAttribute('href', '/logs?route_id=42&stream_id=2&destination_id=10')
    expect(link.getAttribute('href')).not.toContain('status=failed')
  })

  it('does not fabricate a Route link or fake name when the source row has no valid identifier', () => {
    const row = mapLogToDeliveryActivity(evidence({ route_id: -1, stream_id: Number.NaN, latency_ms: -10 }), routeLabels)
    expect(row.routeId).toBeNull()
    expect(row.streamId).toBeNull()
    expect(row.routeName).toBe('—')
    expect(row.latencyMs).toBeNull()
    showLog(evidence({ route_id: -1, stream_id: Number.NaN }))
    expect(screen.queryByRole('link', { name: /Investigate Route.*delivery logs/ })).not.toBeInTheDocument()
  })

  it('investigates a recorded failure from the exact Route and Stream, not the entire Destination log corpus', () => {
    const failure = mapLogToRecentFailure(evidence({
      status: 'FAILED', level: 'ERROR', error_code: null,
    }), routeLabels)
    render(<MemoryRouter><RecentFailuresList failures={[failure]} destinationId={10} compact /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Investigate Route #42 recent failures' }))
      .toHaveAttribute('href', '/logs?route_id=42&stream_id=2&destination_id=10')
    expect(screen.getByText('UNCLASSIFIED')).toBeInTheDocument()
  })

  it('keeps unknown failure Route attribution visibly unavailable rather than inventing a link', () => {
    const failure = mapLogToRecentFailure(evidence({
      status: 'FAILED', level: 'ERROR', route_id: -2, stream_id: 0,
    }), routeLabels)
    expect(failure.routeName).toBe('—')
    expect(failure.routeId).toBeNull()
    expect(failure.streamId).toBeNull()
    render(<MemoryRouter><RecentFailuresList failures={[failure]} destinationId={10} /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: /Investigate .* recent failures/ })).not.toBeInTheDocument()
  })

  it('only scopes to positively observed IDs and retains confirmed failure evidence without creating a false receiver result', () => {
    showLog(evidence({ stream_id: -2, status: 'FAILED', level: 'ERROR' }), Number.NaN, true)
    const link = screen.getByRole('link', { name: 'Investigate Route #42 delivery logs' })
    expect(link).toHaveAttribute('href', '/logs?route_id=42')
    expect(screen.getByText('FAILED')).toBeInTheDocument()
  })
})
