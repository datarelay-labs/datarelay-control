import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { RuntimeFlowTopology } from './runtime-flow-topology'
import { buildRuntimeFlowTopology, MAX_VISIBLE_FLOW_ROUTES } from './runtime-flow-graph-model'

let mountSequence = 0

vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...original,
    ReactFlow: ({
      nodes, edges, onNodeClick, onEdgeClick,
    }: {
      nodes: Node[]
      edges: Edge[]
      onNodeClick?: (event: unknown, item: Node) => void
      onEdgeClick?: (event: unknown, item: Edge) => void
    }) => {
      const [mountId] = useState(() => ++mountSequence)
      return <div>
        <output data-testid="paginated-graph-nodes" data-mount-id={mountId}>
          {nodes.map((node) => node.id).join(',')}
        </output>
        {nodes.map((node) => (
          <div key={`focus-${node.id}`} data-testid={`graph-focus-node-${node.id}`}
            className="react-flow__node" data-id={node.id} tabIndex={0}>{node.id}</div>
        ))}
        {edges.map((edge) => (
          <div key={`focus-${edge.id}`} data-testid={`graph-focus-edge-${edge.id}`}
            className="react-flow__edge" data-id={edge.id} tabIndex={0}>{edge.id}</div>
        ))}
        {nodes.filter((node) => node.data?.kind === 'route').map((node) => (
          <button type="button" key={node.id} data-testid={`graph-node-${node.id}`}
            onClick={() => onNodeClick?.(null, node)}>Node {node.id}</button>
        ))}
        {edges.filter((edge) => edge.data?.gatewayOnly).map((edge) => (
          <button type="button" key={edge.id} data-testid={`graph-edge-${edge.id}`}
            onClick={() => onEdgeClick?.(null, edge)}>Edge {edge.id}</button>
        ))}
      </div>
    },
    Background: () => null,
    Controls: () => null,
  }
})

function snapshot(routeCount: number): OperationalSnapshotResponse {
  const routes = Array.from({ length: routeCount }, (_, index) => ({
    route_id: 100 + index, stream_id: 1, stream_name: 'Security logs',
    destination_id: index === 0 ? null : 11 + index, destination_name: `Receiver ${index}`,
    destination_type: 'SYSLOG_UDP', enabled: true,
    failure_policy: 'retry', health_status: 'HEALTHY' as const,
    delivered_eps_1m: 12, failed_eps_1m: 0, success_rate_5m: 100,
    retry_rate_5m: 0, avg_latency_ms: 7, last_success_at: null,
    last_error_at: null, last_error_message: null,
  }))
  return {
    updated_at: new Date().toISOString(),
    global: {
      health_status: 'HEALTHY', total_streams: 1, enabled_streams: 1,
      running_streams: 1, error_streams: 0, total_routes: routeCount,
      enabled_routes: routeCount, total_destinations: routeCount,
      enabled_destinations: routeCount, total_eps_1m: 12,
      total_eps_5m: 12, avg_latency_ms: 7, last_activity_at: null,
    },
    streams: [{
      stream_id: 1, stream_name: 'Security logs', connector_id: 2, source_id: 3,
      enabled: true, status: 'RUNNING', health_status: 'HEALTHY',
      eps_1m: 12, eps_5m: 12, success_rate_5m: 100,
      failure_rate_5m: 0, avg_latency_ms: 7, route_count: routeCount,
      healthy_route_count: routeCount, failed_route_count: 0,
      last_success_at: null, last_error_at: null, last_error_message: null,
      checkpoint_updated_at: null, checkpoint_lag_seconds: null,
    }],
    routes,
    destinations: Array.from({ length: routeCount }, (_, index) => ({
      destination_id: 11 + index, destination_name: `Receiver ${index}`,
      destination_type: 'SYSLOG_UDP', enabled: true,
      health_status: 'HEALTHY' as const, inbound_eps_1m: 12,
      failed_eps_1m: 0, avg_latency_ms: 7, route_count: 1,
      last_success_at: null, last_error_at: null, last_error_message: null,
    })),
    problems: [],
  }
}

describe('bounded, keyboard-operable runtime data-flow route paging', () => {
  it.each([0, 1, 10, 50, 103])('keeps %s Routes readable without dropping stable identity', (count) => {
    const data = snapshot(count)
    const first = buildRuntimeFlowTopology(data, 1)
    expect(first.totalRoutes).toBe(count)
    expect(first.shownRoutes).toBe(Math.min(count, MAX_VISIBLE_FLOW_ROUTES))
    expect(first.nodes.filter((item) => item.data.kind === 'route')).toHaveLength(first.shownRoutes)
    expect(new Set(first.nodes.map((item) => item.id)).size).toBe(first.nodes.length)
    if (count > 0) expect(first.nodes).toContainEqual(expect.objectContaining({ id: 'route:100' }))
  })

  it('opens the exact Route page, including the final Route past 100', () => {
    const data = snapshot(103)
    const selected = buildRuntimeFlowTopology(data, 1, 202)
    expect(selected.totalRoutes).toBe(103)
    expect(selected.shownRoutes).toBe(1)
    expect(selected.nodes.some((item) => item.id === 'route:202')).toBe(true)
    expect(selected.nodes.some((item) => item.id === 'route:100')).toBe(false)
  })

  it('uses explicit page navigation with a stable, bounded graph', () => {
    render(<MemoryRouter><RuntimeFlowTopology snapshot={snapshot(103)} selectedStreamId={1} /></MemoryRouter>)
    expect(screen.getByTestId('paginated-graph-nodes')).toHaveTextContent('route:100')
    expect(screen.getByTestId('paginated-graph-nodes')).not.toHaveTextContent('route:106')
    expect(screen.getByText(/Routes 1–3 of 103/)).toBeInTheDocument()
    const previous = screen.getByRole('button', { name: 'Previous Routes' })
    const next = screen.getByRole('button', { name: 'Next Routes' })
    expect(previous).toBeDisabled()
    const initialMount = screen.getByTestId('paginated-graph-nodes').getAttribute('data-mount-id')
    fireEvent.click(next)
    // fitView is an initial-mount operation: each route page needs a new fit.
    expect(screen.getByTestId('paginated-graph-nodes')).not.toHaveAttribute('data-mount-id', initialMount)
    expect(screen.getByText(/Routes 4–6 of 103/)).toBeInTheDocument()
    expect(screen.getByTestId('paginated-graph-nodes')).toHaveTextContent('route:103')
    expect(previous).toBeEnabled()
    for (let index = 0; index < 33; index++) fireEvent.click(next)
    expect(screen.getByText(/Routes 103–103 of 103/)).toBeInTheDocument()
    expect(screen.getByTestId('paginated-graph-nodes')).toHaveTextContent('route:202')
    expect(next).toBeDisabled()
  })

  it('automatically focuses a newly selected Route and resets the old manual page', () => {
    const data = snapshot(103)
    const { rerender } = render(
      <MemoryRouter><RuntimeFlowTopology snapshot={data} selectedStreamId={1} selectedRouteId={101} /></MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next Routes' }))
    expect(screen.getByText(/Routes 4–6 of 103/)).toBeInTheDocument()
    rerender(<MemoryRouter><RuntimeFlowTopology snapshot={data} selectedStreamId={1} selectedRouteId={202} /></MemoryRouter>)
    expect(screen.getByText(/Routes 103–103 of 103/)).toBeInTheDocument()
    expect(screen.getByTestId('paginated-graph-nodes')).toHaveTextContent('route:202')
  })

  it('includes Route with no Destination in accessible navigation rather than silently omitting it', () => {
    render(<MemoryRouter><RuntimeFlowTopology snapshot={snapshot(10)} selectedStreamId={1} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Show accessible path list' }))
    const routes = screen.getByRole('list', { name: 'Data paths with runtime evidence' })
    expect(routes).toHaveTextContent('Route #100')
    expect(routes).toHaveTextContent('Destination not configured')
    expect(routes.querySelectorAll('li')).toHaveLength(MAX_VISIBLE_FLOW_ROUTES)
    expect(screen.getByRole('link', { name: 'Route #100' })).toBeInTheDocument()
  })
})


describe('Flow topology node/edge selection integration', () => {
  it('selects real Route IDs from graph nodes and delivery edges but respects owner refusal', () => {
    const choose = vi.fn((_routeId: number) => true)
    render(
      <MemoryRouter>
        <RuntimeFlowTopology snapshot={snapshot(10)} selectedStreamId={1} onInspectRoute={choose} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('graph-node-route:101'))
    expect(choose).toHaveBeenLastCalledWith(101)
    expect(screen.getByTestId('runtime-data-flow-inspector')).toHaveTextContent('Route #101')

    fireEvent.click(screen.getByTestId('graph-edge-route:102->destination:13'))
    expect(choose).toHaveBeenLastCalledWith(102)
    expect(screen.getByTestId('runtime-data-flow-inspector')).toHaveTextContent('Selected delivery relation')

    choose.mockReturnValue(false)
    fireEvent.click(screen.getByTestId('graph-node-route:100'))
    expect(choose).toHaveBeenLastCalledWith(100)
    expect(screen.getByTestId('runtime-data-flow-inspector')).toHaveTextContent('Selected delivery relation')
    expect(screen.getByTestId('runtime-data-flow-inspector')).not.toHaveTextContent('Route #100')
  })
})

describe('Real keyboard activation of selectable graph entities', () => {
  it('Enter and Space inspect the focused Route node or edge; guard preserves selection', () => {
    const choose = vi.fn((_routeId: number) => true)
    render(<MemoryRouter>
      <RuntimeFlowTopology snapshot={snapshot(10)} selectedStreamId={1} onInspectRoute={choose} />
    </MemoryRouter>)

    const node = screen.getByTestId('graph-focus-node-route:101')
    node.focus()
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(choose).toHaveBeenLastCalledWith(101)
    expect(screen.getByTestId('runtime-data-flow-inspector')).toHaveTextContent('Route #101')

    const edge = screen.getByTestId('graph-focus-edge-route:102->destination:13')
    edge.focus()
    fireEvent.keyDown(edge, { key: ' ' })
    expect(choose).toHaveBeenLastCalledWith(102)
    expect(screen.getByTestId('runtime-data-flow-inspector')).toHaveTextContent('Selected delivery relation')

    choose.mockReturnValue(false)
    const denied = screen.getByTestId('graph-focus-node-route:100')
    denied.focus()
    fireEvent.keyDown(denied, { key: ' ' })
    expect(choose).toHaveBeenLastCalledWith(100)
    expect(screen.getByTestId('runtime-data-flow-inspector')).toHaveTextContent('Selected delivery relation')
  })
})

describe('readable graph at constrained desktop width', () => {
  it('offers keyboard-focusable internal horizontal scrolling while retaining a bounded Route page', () => {
    render(<MemoryRouter><RuntimeFlowTopology snapshot={snapshot(103)} selectedStreamId={1} /></MemoryRouter>)
    const scrollRegion = screen.getByRole('region', { name: 'Scrollable data flow graph' })
    expect(scrollRegion).toHaveAttribute('tabindex', '0')
    expect(scrollRegion.querySelector('[data-testid="runtime-data-flow-canvas"]')).toBeInTheDocument()
    expect(screen.getByTestId('paginated-graph-nodes')).toHaveTextContent('route:100')
    expect(screen.getByText(/Routes 1–3 of 103/)).toBeInTheDocument()
  })
})
