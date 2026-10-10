import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { buildRouteRowsFromOperationalSnapshot } from './routes-overview-helpers'
import { RoutesFlowTreeTable } from './routes-flow-tree-table'

function evidence(): OperationalSnapshotResponse {
  const now = new Date().toISOString()
  return {
    global: {
      health_status: 'HEALTHY',
      total_streams: 1,
      enabled_streams: 1,
      running_streams: 1,
      error_streams: 0,
      total_routes: 1,
      enabled_routes: 1,
      total_destinations: 1,
      enabled_destinations: 1,
      total_eps_1m: 7,
      total_eps_5m: 6,
      avg_latency_ms: 12,
      last_activity_at: now,
    },
    streams: [{
      stream_id: 1, stream_name: 'Finance flow', connector_id: 2, source_id: 3,
      enabled: true, status: 'RUNNING', health_status: 'HEALTHY',
      eps_1m: 7, eps_5m: 6, success_rate_5m: 100, failure_rate_5m: 0,
      avg_latency_ms: 12, route_count: 1, healthy_route_count: 1,
      failed_route_count: 0, last_success_at: now, last_error_at: null,
      last_error_message: null, checkpoint_updated_at: now, checkpoint_lag_seconds: 0,
    }],
    routes: [{
      route_id: 42, stream_id: 1, stream_name: 'Finance flow',
      destination_id: 10, destination_name: 'Analytics sink',
      destination_type: 'WEBHOOK_POST', enabled: true,
      failure_policy: 'LOG_AND_CONTINUE', health_status: 'HEALTHY',
      delivered_eps_1m: 3, failed_eps_1m: 0, success_rate_5m: 100,
      retry_rate_5m: 0, avg_latency_ms: 12,
      last_success_at: now, last_error_at: null, last_error_message: null,
    }],
    destinations: [{
      destination_id: 10, destination_name: 'Analytics sink',
      destination_type: 'WEBHOOK_POST', enabled: true,
      health_status: 'HEALTHY', inbound_eps_1m: 3, failed_eps_1m: 0,
      avg_latency_ms: 12, route_count: 1, last_success_at: now,
      last_error_at: null, last_error_message: null,
    }],
    problems: [], updated_at: now,
  } as OperationalSnapshotResponse
}

function mount(snapshot: OperationalSnapshotResponse | null, loading = false) {
  return render(
    <MemoryRouter>
      <RoutesFlowTreeTable
        snapshot={snapshot}
        consoleRows={snapshot ? buildRouteRowsFromOperationalSnapshot(snapshot) : []}
        loading={loading}
      />
    </MemoryRouter>,
  )
}

describe('Flow-First expert delivery table — runtime evidence and keyboard safety', () => {
  it('does not claim an empty installation when the runtime snapshot is absent', () => {
    mount(null)
    expect(screen.getByTestId('routes-flow-inventory-state')).toHaveTextContent('Route inventory not verified')
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Streams' })).toHaveAttribute('href', '/streams')
  })

  it('shows an actual empty state only with fresh authoritative zero-route evidence', () => {
    const s = evidence()
    s.global.total_routes = 0
    s.routes = []
    const { rerender } = mount(s)
    expect(screen.getByText('No routes configured yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Route inventory not verified/)).not.toBeInTheDocument()
    s.global.total_routes = 5
    rerender(<MemoryRouter><RoutesFlowTreeTable snapshot={{ ...s }} consoleRows={[]} /></MemoryRouter>)
    expect(screen.getByTestId('routes-flow-inventory-state')).toHaveTextContent('Route inventory not verified')
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
  })

  it('does not classify an aged snapshot as a current healthy Route', () => {
    const s = evidence()
    s.updated_at = '2026-01-01T00:00:00Z'
    mount(s)
    expect(screen.getByTestId('routes-flow-snapshot-status')).toHaveTextContent('Stale')
    expect(screen.getByTestId('routes-flow-route-health-42')).toHaveTextContent('Last reported Healthy')
    expect(screen.getByTestId('routes-flow-route-health-42')).not.toHaveClass('text-emerald-700')
  })

  it('never invents an observation timestamp for invalid snapshot dates', () => {
    const s = evidence()
    s.updated_at = 'not-a-time'
    mount(s)
    expect(screen.getByTestId('routes-flow-snapshot-status')).toHaveTextContent('Snapshot time not verified')
    expect(screen.getByTestId('routes-flow-snapshot-status').querySelector('time')).toBeNull()
  })

  it('keeps the Stream navigation link outside the expanding button', async () => {
    const user = userEvent.setup()
    mount(evidence())
    const link = screen.getByRole('link', { name: 'Finance flow' })
    expect(link).toHaveAttribute('href', '/streams/1/runtime')
    expect(link.closest('button')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Collapse Finance flow routes' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'R-0042' })).toHaveAttribute('href', '/routes/42/edit')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Expand Finance flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/streams/1/runtime')
  })

  it('offers a read-only investigate → destination evidence path from the expert Route row', () => {
    mount(evidence())
    expect(screen.getByRole('link', { name: 'Investigate R-0042 delivery logs' }))
      .toHaveAttribute('href', '/logs?route_id=42&stream_id=1&destination_id=10')
    expect(screen.getByRole('link', { name: 'View Analytics sink destination' }))
      .toHaveAttribute('href', '/destinations/10')
    expect(screen.getByRole('link', { name: 'R-0042' }))
      .toHaveAttribute('href', '/routes/42/edit')
  })

  it('does not invent a destination details link if the Route has no valid receiver ID', () => {
    const s = evidence()
    s.routes[0]!.destination_id = -2
    mount(s)
    expect(screen.queryByRole('link', { name: /View .* destination/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Investigate R-0042 delivery logs' }))
      .toHaveAttribute('href', '/logs?route_id=42&stream_id=1')
  })

  it('loading from an unverified snapshot does not declare there are no Routes', () => {
    mount(null, true)
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
  })
})
