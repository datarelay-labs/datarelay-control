import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { OperationalRouteSnapshot, OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { buildRouteRowsFromOperationalSnapshot } from './routes-overview-helpers'
import { RoutesArchitectureWorkspace } from './routes-architecture-workspace'

const recent = () => new Date().toISOString()

function route(id: number, streamId: number, destinationId: number, health: OperationalRouteSnapshot['health_status'], enabled = true): OperationalRouteSnapshot {
  return {
    route_id: id,
    stream_id: streamId,
    stream_name: 'Shared display name',
    destination_id: destinationId,
    destination_name: `Target ${destinationId}`,
    destination_type: 'WEBHOOK_POST',
    enabled,
    failure_policy: 'LOG_AND_CONTINUE',
    health_status: health,
    delivered_eps_1m: 3,
    failed_eps_1m: health === 'ERROR' ? 1 : 0,
    success_rate_5m: health === 'HEALTHY' ? 100 : 90,
    retry_rate_5m: 0,
    avg_latency_ms: 14,
    last_success_at: recent(),
    last_error_at: null,
    last_error_message: null,
  }
}

function snapshotFor(routes = [
  route(1, 1, 101, 'HEALTHY'),
  route(2, 1, 102, 'DEGRADED'),
  route(6, 2, 106, 'ERROR'),
]): OperationalSnapshotResponse {
  return {
    global: {
      health_status: 'DEGRADED',
      total_streams: 2,
      enabled_streams: 2,
      running_streams: 2,
      error_streams: 0,
      total_routes: routes.length,
      enabled_routes: routes.filter((r) => r.enabled).length,
      total_destinations: routes.length,
      enabled_destinations: routes.length,
      total_eps_1m: 13,
      total_eps_5m: 12,
      avg_latency_ms: 14,
      last_activity_at: recent(),
    },
    streams: [1, 2].map((id) => ({
      stream_id: id,
      stream_name: 'Shared display name',
      connector_id: id,
      source_id: id,
      enabled: true,
      status: 'RUNNING' as const,
      health_status: 'HEALTHY' as const,
      eps_1m: id === 1 ? 8 : 5,
      eps_5m: id === 1 ? 8 : 5,
      success_rate_5m: 98,
      failure_rate_5m: 2,
      avg_latency_ms: 14,
      route_count: routes.filter((r) => r.stream_id === id).length,
      healthy_route_count: 0,
      failed_route_count: 0,
      last_success_at: recent(),
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    })),
    routes,
    destinations: routes.map((r) => ({
      destination_id: r.destination_id!,
      destination_name: r.destination_name ?? 'Unknown Destination',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      health_status: 'HEALTHY',
      inbound_eps_1m: 3,
      failed_eps_1m: 0,
      avg_latency_ms: 14,
      route_count: 1,
      last_success_at: recent(),
      last_error_at: null,
      last_error_message: null,
    })),
    problems: [],
    updated_at: recent(),
  } as OperationalSnapshotResponse
}

function GraphHarness({ snapshot, requestFailed = false }: { snapshot: OperationalSnapshotResponse; requestFailed?: boolean }) {
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null)
  return (
    <MemoryRouter>
      <RoutesArchitectureWorkspace
        snapshot={snapshot}
        consoleRows={buildRouteRowsFromOperationalSnapshot(snapshot)}
        selectedStreamId={selectedStreamId}
        onSelectStream={setSelectedStreamId}
        requestFailed={requestFailed}
      />
    </MemoryRouter>
  )
}

describe('Data Flows topology: operator priority and bounded exploration', () => {
  it('keeps the flow explanation discoverable without occupying the operations viewport by default', async () => {
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor()} />)
    const guide = screen.getByTestId('routes-mental-model')
    expect(guide.tagName).toBe('DETAILS')
    expect(guide).not.toHaveAttribute('open')
    await user.click(screen.getByText('How delivery paths work'))
    expect(guide).toHaveAttribute('open')
    expect(guide).toHaveTextContent('One Stream can fan out through many Routes')
  })

  it('puts actual Error before Warning and focuses the correct Stream and Route, not matching display names', async () => {
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor()} />)
    const attention = screen.getByTestId('routes-architecture-attention')
    expect(attention).toHaveTextContent('2 need attention')
    expect(attention).toHaveTextContent('0 disabled')
    const actions = within(screen.getByTestId('routes-architecture-issue-list')).getAllByRole('button')
    expect(actions[0]).toHaveAccessibleName('Inspect Error Route R-0006 in Stream #2')
    expect(actions[1]).toHaveAccessibleName('Inspect Warning Route R-0002 in Stream #1')
    await user.click(screen.getByTestId('routes-architecture-review-first'))
    expect(screen.getByTestId('routes-architecture-route-6')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('routes-architecture-stream-2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('routes-architecture-route-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stream #2 · Route R-0006')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route output (1m, gateway-reported)')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Not verified by this snapshot')
    await user.click(actions[1]!)
    expect(screen.getByTestId('routes-architecture-route-2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stream #1 · Route R-0002')
  })

  it('does not treat a failed or old operational read as a live incident or a healthy receiver', () => {
    const old = { ...snapshotFor(), updated_at: '2026-01-01T00:00:00Z' }
    render(<GraphHarness snapshot={old} requestFailed />)
    expect(screen.getByTestId('routes-architecture-attention')).toHaveTextContent('Last reported Route conditions')
    expect(screen.getByTestId('routes-architecture-issue-list')).toHaveTextContent('Last reported Error')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stale')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Not verified by this snapshot')
  })

  it('excludes disabled paths from error queue and reports no errors without declaring delivery verified', () => {
    render(<GraphHarness snapshot={snapshotFor([
      route(8, 1, 108, 'ERROR', false),
      route(9, 1, 109, 'HEALTHY'),
    ])} />)
    expect(screen.getByTestId('routes-architecture-attention')).toHaveTextContent('0 need attention')
    expect(screen.getByTestId('routes-architecture-attention')).toHaveTextContent('1 disabled')
    expect(screen.queryByTestId('routes-architecture-review-first')).not.toBeInTheDocument()
    expect(screen.getByTestId('routes-architecture-attention')).toHaveTextContent('receiver ingestion is not thereby verified')
  })

  it('limits initial graph cards to 12 with explicit expansion, preserves keyboard-accessible Route inspection', async () => {
    const routes = Array.from({ length: 20 }, (_, index) => route(index + 1, 1, index + 100, 'HEALTHY'))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor(routes)} />)
    const graph = screen.getByTestId('routes-architecture-graph')
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(12)
    const show = screen.getByTestId('routes-architecture-show-paths')
    expect(show).toHaveAttribute('aria-expanded', 'false')
    await user.click(show)
    expect(screen.getByTestId('routes-architecture-show-paths')).toHaveAttribute('aria-expanded', 'true')
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(20)
    const last = screen.getByTestId('routes-architecture-route-20')
    last.focus()
    await user.keyboard('{Enter}')
    expect(last).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0020')
    await user.click(screen.getByTestId('routes-architecture-show-paths'))
    // Collapsing the list never discards the operator's selected Route.
    expect(screen.getByTestId('routes-architecture-route-20')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0020')
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(13)
  })

  it('loads 140 delivery paths in bounded batches without losing selected Route inspection', async () => {
    const routes = Array.from({ length: 140 }, (_, index) =>
      route(index + 1, 1, index + 100, 'HEALTHY'))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor(routes)} />)
    const graph = screen.getByTestId('routes-architecture-graph')
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(12)
    await user.click(screen.getByRole('button', { name: 'Show next delivery paths (12 of 140 shown)' }))
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(32)
    const inspected = screen.getByTestId('routes-architecture-route-30')
    await user.click(inspected)
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0030')
    await user.click(screen.getByRole('button', { name: 'Show next delivery paths (32 of 140 shown)' }))
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(52)
    expect(screen.getByTestId('routes-architecture-route-30')).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByTestId('routes-architecture-show-fewer'))
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(13)
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0030')
  })

  it('keeps a 140-Route topology bounded while inspecting an issue beyond the first 12 paths', async () => {
    const routes = Array.from({ length: 140 }, (_, index) =>
      route(index + 1, 1, index + 100, index === 139 ? 'ERROR' : 'HEALTHY'))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor(routes)} />)
    const graph = screen.getByTestId('routes-architecture-graph')
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(12)
    await user.click(screen.getByTestId('routes-architecture-review-first'))
    expect(screen.getByTestId('routes-architecture-route-140')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0140')
    // Issue navigation must not force all 140 DOM nodes into the graph.
    expect(within(graph).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(13)
    expect(screen.getByTestId('routes-architecture-show-paths')).toHaveAttribute('aria-expanded', 'false')
  })

  it('bounds the Stream selector on large topologies while keeping search and issue drill-down usable', async () => {
    const manyRoutes = Array.from({ length: 120 }, (_, index) => ({
      ...route(index + 1, index + 1, index + 501, index === 119 ? 'ERROR' : 'HEALTHY'),
      stream_name: index === 119 ? 'Rare collection path' : `Flow ${index + 1}`,
    }))
    const data = snapshotFor(manyRoutes)
    data.streams = manyRoutes.map((r, index) => ({
      ...data.streams[0]!,
      stream_id: r.stream_id,
      stream_name: index === 119 ? 'Rare collection path' : `Flow ${index + 1}`,
      eps_1m: 120 - index,
    }))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={data} />)

    const streamList = screen.getByRole('navigation', { name: 'Choose a Stream for delivery' })
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(12)
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stream #1')

    await user.type(within(streamList).getByRole('searchbox', { name: 'Find Stream by name or ID' }), 'Rare collection')
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(1)
    await user.click(screen.getByTestId('routes-architecture-stream-120'))
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stream #120')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0120')

    await user.clear(within(streamList).getByRole('searchbox', { name: 'Find Stream by name or ID' }))
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(13)
    await user.click(screen.getByTestId('routes-architecture-review-first'))
    expect(screen.getByTestId('routes-architecture-stream-120')).toHaveAttribute('aria-pressed', 'true')
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(13)
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0120')
    expect(screen.getByTestId('routes-architecture-show-streams')).toHaveAttribute('aria-expanded', 'false')
  })

  it('explains an empty Stream search and expands or collapses larger matching results', async () => {
    const manyRoutes = Array.from({ length: 16 }, (_, index) => ({
      ...route(index + 1, index + 1, index + 300, 'HEALTHY'),
      stream_name: `Flow ${index + 1}`,
    }))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor(manyRoutes)} />)
    const streamList = screen.getByRole('navigation', { name: 'Choose a Stream for delivery' })
    const query = within(streamList).getByRole('searchbox', { name: 'Find Stream by name or ID' })

    await user.type(query, 'no-such-stream')
    expect(within(streamList).queryAllByTestId(/^routes-architecture-stream-/)).toHaveLength(0)
    expect(within(streamList).getByText(/No matching Streams/)).toBeInTheDocument()
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stream #1')

    await user.clear(query)
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(12)
    await user.click(screen.getByRole('button', { name: 'Show all 16 Streams' }))
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(16)
    await user.click(screen.getByRole('button', { name: 'Show fewer Streams' }))
    expect(within(streamList).getAllByTestId(/^routes-architecture-stream-/)).toHaveLength(12)
  })

  it('reveals a large warning queue in bounded steps without mounting every issue at once', async () => {
    const manyRoutes = Array.from({ length: 105 }, (_, index) => route(index + 1, 1, index + 200, 'DEGRADED'))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor(manyRoutes)} />)
    const list = screen.getByTestId('routes-architecture-issue-list')
    expect(within(list).getAllByRole('button')).toHaveLength(5)
    const expand = screen.getByRole('button', { name: 'Show next issues (4 of 105 shown)' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')

    await user.click(expand)
    expect(within(list).getAllByRole('button')).toHaveLength(25)
    expect(screen.queryByRole('button', { name: 'Inspect Warning Route R-0105 in Stream #1' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Inspect Warning Route R-0024 in Stream #1' }))
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0024')

    await user.click(screen.getByRole('button', { name: 'Show next issues (24 of 105 shown)' }))
    expect(within(list).getAllByRole('button')).toHaveLength(45)
    expect(screen.getByTestId('routes-architecture-show-paths')).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands the issue queue for many paths and allows direct inspection of a later problem Route', async () => {
    const routes = Array.from({ length: 18 }, (_, index) => route(index + 1, 1, index + 100, 'DEGRADED'))
    const user = userEvent.setup()
    render(<GraphHarness snapshot={snapshotFor(routes)} />)
    expect(within(screen.getByTestId('routes-architecture-issue-list')).getAllByRole('button')).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'Show all 18 issues' }))
    await user.click(screen.getByRole('button', { name: 'Inspect Warning Route R-0018 in Stream #1' }))
    expect(screen.getByTestId('routes-architecture-route-18')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Route R-0018')
    expect(screen.getByTestId('routes-architecture-show-paths')).toHaveAttribute('aria-expanded', 'false')
    expect(within(screen.getByTestId('routes-architecture-graph')).getAllByTestId(/^routes-architecture-route-/)).toHaveLength(13)
  })
})
