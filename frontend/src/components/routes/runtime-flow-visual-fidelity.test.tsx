import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Node, NodeProps } from '@xyflow/react'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { FlowNodeData } from './runtime-flow-graph-model'
import { RuntimeFlowNode } from './runtime-flow-node'
import { formatFlowRate } from './runtime-flow-format'
import { RuntimeFlowInspector } from './runtime-flow-inspector'
import { buildRuntimeFlowTopology } from './runtime-flow-graph-model'

vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  return { ...original, Handle: () => <span data-testid="read-only-flow-handle" /> }
})

function snapshot(): OperationalSnapshotResponse {
  return {
    updated_at: '2026-10-24T12:00:00Z',
    global: {
      health_status: 'HEALTHY', total_streams: 1, enabled_streams: 1,
      running_streams: 1, error_streams: 0, total_routes: 1, enabled_routes: 1,
      total_destinations: 1, enabled_destinations: 1, total_eps_1m: 24.4,
      total_eps_5m: 24.4, avg_latency_ms: 12, last_activity_at: null,
    },
    streams: [{
      stream_id: 1, stream_name: 'Security Events', connector_id: 4, source_id: 2,
      enabled: true, status: 'RUNNING', health_status: 'HEALTHY',
      eps_1m: 24.4, eps_5m: 23.5, success_rate_5m: 100,
      failure_rate_5m: 0, avg_latency_ms: 12, route_count: 1,
      healthy_route_count: 1, failed_route_count: 0,
      last_success_at: null, last_error_at: null, last_error_message: null,
      checkpoint_updated_at: null, checkpoint_lag_seconds: null,
    }],
    routes: [{
      route_id: 12, stream_id: 1, stream_name: 'Security Events',
      destination_id: 27, destination_name: 'Syslog UDP', destination_type: 'SYSLOG_UDP',
      enabled: true, health_status: 'HEALTHY', failure_policy: 'retry',
      delivered_eps_1m: 12.4, failed_eps_1m: 0, success_rate_5m: 99.8,
      retry_rate_5m: 0, avg_latency_ms: 12,
      last_success_at: null, last_error_at: null, last_error_message: null,
    }],
    destinations: [{
      destination_id: 27, destination_name: 'Syslog UDP',
      destination_type: 'SYSLOG_UDP', enabled: true, health_status: 'HEALTHY',
      inbound_eps_1m: 12.4, failed_eps_1m: 0, avg_latency_ms: 12,
      route_count: 1, last_success_at: null, last_error_at: null, last_error_message: null,
    }],
    problems: [],
  }
}

describe('runtime flow visual fidelity and evidence', () => {
  it('preserves measured Stream, Route and Destination rates in their respective custom node cards', () => {
    const graph = buildRuntimeFlowTopology(snapshot(), 1, null, Date.parse('2026-10-24T12:00:10Z'))
    const kinds = new Map(graph.nodes.map((node) => [node.data.kind, node]))
    expect(kinds.get('source')?.type).toBe('source')
    expect(kinds.get('source')?.data.metricEps).toBeNull()
    expect(kinds.get('stream')?.data.metricEps).toBe(24.4)
    expect(kinds.get('route')?.data.metricEps).toBe(12.4)
    expect(kinds.get('destination')?.data.metricEps).toBe(12.4)
    expect(graph.nodes.every((node) => node.type === node.data.kind)).toBe(true)
  })

  it('renders a selected status-based node without inventing Source throughput', () => {
    const props = {
      id: 'route:12', selected: true, type: 'route',
      data: {
        kind: 'route', label: 'Route #12', detail: 'Observed gateway delivery',
        status: 'HEALTHY', metricEps: 12.4,
        metricLabel: 'Gateway delivery · 1m', href: '/routes/12',
      },
    } as unknown as NodeProps<Node<FlowNodeData>>
    render(<RuntimeFlowNode {...props} />)
    expect(screen.getByText('Route #12')).toBeInTheDocument()
    expect(screen.getByText('12.4 evt/s')).toBeInTheDocument()
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-flow-card-route')).toHaveClass('control-runtime-flow-card--selected')
    expect(screen.getAllByTestId('read-only-flow-handle')).toHaveLength(2)
    expect(formatFlowRate(null)).toBe('—')
    expect(formatFlowRate(12400)).toBe('12.4K')
    expect(formatFlowRate(1200000)).toBe('1.2M')
  })

  it('provides the selected Route diagnostics and retains unknown receiver proof', () => {
    const routeNode: Node<FlowNodeData> = {
      id: 'route:12', type: 'route', position: { x: 0, y: 0 },
      data: { kind: 'route', label: 'Route #12', detail: 'Healthy',
        status: 'HEALTHY', href: '/routes/12' },
    }
    render(
      <MemoryRouter>
        <RuntimeFlowInspector snapshot={snapshot()} selectedStreamId={1}
          selectedNode={routeNode} shownRoutes={1} totalRoutes={1} stale={false} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('complementary', { name: 'Selected flow details' })).toBeInTheDocument()
    expect(screen.getByText('12.4')).toBeInTheDocument()
    expect(screen.getByText('99.8%')).toBeInTheDocument()
    expect(screen.getByText('12 ms')).toBeInTheDocument()
    expect(screen.getByText(/receiver receipt not verified/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Inspect Route' })).toHaveAttribute('href', '/routes/12/edit')
  })

  it('selects an existing Route inside its owning workspace instead of navigating away from drafts', () => {
    const onInspectRoute = vi.fn()
    const routeNode: Node<FlowNodeData> = {
      id: 'route:12', type: 'route', position: { x: 0, y: 0 },
      data: { kind: 'route', label: 'Route #12', detail: 'Healthy',
        status: 'HEALTHY', href: '/routes/12' },
    }
    render(<MemoryRouter>
      <RuntimeFlowInspector snapshot={snapshot()} selectedStreamId={1}
        selectedNode={routeNode} shownRoutes={1} totalRoutes={1} stale={false}
        onInspectRoute={onInspectRoute} />
    </MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect in workspace' }))
    expect(onInspectRoute).toHaveBeenCalledWith(12)
    expect(screen.queryByRole('link', { name: 'Inspect Route' })).not.toBeInTheDocument()
  })

  it('does not attribute Stream ingestion telemetry to an unverified upstream Source', () => {
    const sourceNode: Node<FlowNodeData> = {
      id: 'source:2', type: 'source', position: { x: 0, y: 0 },
      data: { kind: 'source', label: 'Source #2', detail: 'Topology relation only',
        status: 'Topology only', metricEps: null, href: null },
    }
    render(<MemoryRouter>
      <RuntimeFlowInspector snapshot={snapshot()} selectedStreamId={1}
        selectedNode={sourceNode} shownRoutes={1} totalRoutes={1} stale={false} />
    </MemoryRouter>)
    const rateRow = screen.getByText('Upstream source · rate not observed').parentElement
    expect(rateRow?.querySelector('strong')).toHaveTextContent('—')
    expect(rateRow?.querySelector('strong')).not.toHaveTextContent('24.4')
  })

  it('shows Destination-specific gateway rate instead of Stream ingest EPS', () => {
    const destinationNode: Node<FlowNodeData> = {
      id: 'destination:27', type: 'destination', position: { x: 0, y: 0 },
      data: { kind: 'destination', label: 'Syslog UDP', detail: 'Gateway destination',
        status: 'HEALTHY', metricEps: 12.4, href: '/destinations/27' },
    }
    render(<MemoryRouter>
      <RuntimeFlowInspector snapshot={snapshot()} selectedStreamId={1}
        selectedNode={destinationNode} shownRoutes={1} totalRoutes={1} stale={false} />
    </MemoryRouter>)
    const rateRow = screen.getByText('Gateway destination inbound · 1 min').parentElement
    expect(rateRow?.querySelector('strong')).toHaveTextContent('12.4')
    expect(rateRow?.querySelector('strong')).not.toHaveTextContent('24.4')
  })

  it('labels stale evidence rather than suggesting current health', () => {
    render(<MemoryRouter>
      <RuntimeFlowInspector snapshot={snapshot()} selectedStreamId={1}
        shownRoutes={1} totalRoutes={1} stale />
    </MemoryRouter>)
    expect(screen.getByText('Unknown · last reported')).toBeInTheDocument()
    expect(screen.getByText('Stream ingest · 1 min · last reported')).toBeInTheDocument()
  })
})
