import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { DashboardLiveFlowsPanel } from './dashboard-live-flows-panel'

vi.mock('../routes/runtime-flow-topology', () => ({
  RuntimeFlowTopology: ({ selectedStreamId, requestFailed }: {
    selectedStreamId: number; requestFailed?: boolean
  }) => <p data-testid="graph-route-selection">Runtime Stream #{selectedStreamId} · error {String(requestFailed)}</p>,
}))

function example(): OperationalSnapshotResponse {
  const updatedAt = new Date().toISOString()
  const stream = (id: number, eps: number) => ({
    stream_id: id, stream_name: `Audit ${id}`, connector_id: id, source_id: id, enabled: true,
    status: 'RUNNING', health_status: 'HEALTHY' as const, eps_1m: eps, eps_5m: eps,
    success_rate_5m: 100, failure_rate_5m: 0, avg_latency_ms: 12,
    route_count: 1, healthy_route_count: 1, failed_route_count: 0,
    last_success_at: null, last_error_at: null, last_error_message: null,
    checkpoint_updated_at: null, checkpoint_lag_seconds: null,
  })
  const route = (id: number, streamId: number) => ({
    route_id: id, stream_id: streamId, stream_name: `Audit ${streamId}`,
    destination_id: id + 200, destination_name: `Target ${id}`, destination_type: 'HTTP',
    enabled: true, failure_policy: null, health_status: 'HEALTHY' as const,
    delivered_eps_1m: 1, failed_eps_1m: 0, success_rate_5m: 100, retry_rate_5m: 0,
    avg_latency_ms: 12, last_success_at: null, last_error_at: null, last_error_message: null,
  })
  return {
    updated_at: updatedAt,
    global: {
      health_status: 'HEALTHY', total_streams: 2, enabled_streams: 2,
      running_streams: 2, error_streams: 0, total_routes: 2, enabled_routes: 2,
      total_destinations: 2, enabled_destinations: 2, total_eps_1m: 15,
      total_eps_5m: 15, avg_latency_ms: 12, last_activity_at: null,
    },
    streams: [stream(1, 2), stream(2, 13)],
    routes: [route(101, 1), route(102, 2)],
    destinations: [],
    problems: [],
  }
}
function show(snapshot: OperationalSnapshotResponse, requestFailed = false) {
  return render(<MemoryRouter><DashboardLiveFlowsPanel snapshot={snapshot} requestFailed={requestFailed}/></MemoryRouter>)
}

describe('Dashboard live data flow summary', () => {
  it('does not add a decorative diagram to a verified no-Route installation', () => {
    const snapshot = example()
    snapshot.routes = []
    const { container } = show(snapshot)
    expect(container.firstChild).toBeNull()
  })
  it('defaults to the highest observed Stream ingest rate and uses real route deep link', () => {
    show(example())
    expect(screen.getByTestId('graph-route-selection')).toHaveTextContent('Runtime Stream #2')
    expect(screen.getByRole('link', { name: /Explore Data Flows/ })).toHaveAttribute('href', '/routes?stream_id=2')
    expect(screen.getByTestId('dashboard-live-flow-status')).toHaveTextContent('Current snapshot')
  })
  it('lets an operator switch to a different actual Stream, preserving IDs', async () => {
    const user = userEvent.setup()
    show(example())
    await user.selectOptions(screen.getByLabelText('Select data flow Stream'), '1')
    expect(screen.getByTestId('graph-route-selection')).toHaveTextContent('Runtime Stream #1')
    expect(screen.getByRole('link', { name: /Explore Data Flows/ })).toHaveAttribute('href', '/routes?stream_id=1')
  })
  it('identifies missing or stale runtime evidence and forwards read failures', () => {
    const snapshot = example()
    snapshot.updated_at = '2020-01-01T00:00:00Z'
    show(snapshot, true)
    expect(screen.getByTestId('dashboard-live-flow-status')).toHaveTextContent('Last reported / unknown freshness')
    expect(screen.getByTestId('graph-route-selection')).toHaveTextContent('error true')
  })
  it('excludes unobserved streams, even when Stream inventory includes them', () => {
    const snapshot = example()
    snapshot.routes = snapshot.routes.filter((route) => route.stream_id === 1)
    show(snapshot)
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByTestId('graph-route-selection')).toHaveTextContent('Runtime Stream #1')
  })
})
