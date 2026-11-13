import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { RuntimeFlowTopology } from './runtime-flow-topology'

vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...original,
    ReactFlow: ({ colorMode, edges }: { colorMode: string; edges: Edge[] }) => (
      <div data-testid="runtime-react-flow-theme" data-active={edges.filter((edge) => edge.animated).length}>
        {colorMode}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
  }
})

const sample = (): OperationalSnapshotResponse => ({
  updated_at: new Date().toISOString(),
  global: {
    health_status: 'HEALTHY', total_streams: 1, enabled_streams: 1,
    running_streams: 1, error_streams: 0, total_routes: 1, enabled_routes: 1,
    total_destinations: 1, enabled_destinations: 1, total_eps_1m: 12,
    total_eps_5m: 12, avg_latency_ms: null, last_activity_at: null,
  },
  streams: [{
    stream_id: 1, stream_name: 'Audit', connector_id: 4, source_id: 7,
    enabled: true, status: 'RUNNING', health_status: 'HEALTHY',
    eps_1m: 12, eps_5m: 12, success_rate_5m: 100,
    failure_rate_5m: 0, avg_latency_ms: null, route_count: 1,
    healthy_route_count: 1, failed_route_count: 0,
    last_success_at: null, last_error_at: null, last_error_message: null,
    checkpoint_updated_at: null, checkpoint_lag_seconds: null,
  }],
  routes: [{
    route_id: 20, stream_id: 1, stream_name: 'Audit', destination_id: 30,
    destination_name: 'UDP', destination_type: 'SYSLOG_UDP', enabled: true,
    failure_policy: null, health_status: 'HEALTHY', delivered_eps_1m: 12,
    failed_eps_1m: 0, success_rate_5m: 100, retry_rate_5m: 0,
    avg_latency_ms: null, last_success_at: null, last_error_at: null, last_error_message: null,
  }],
  destinations: [{
    destination_id: 30, destination_name: 'UDP', destination_type: 'SYSLOG_UDP',
    enabled: true, health_status: 'HEALTHY', inbound_eps_1m: 12,
    failed_eps_1m: 0, avg_latency_ms: null, route_count: 1,
    last_success_at: null, last_error_at: null, last_error_message: null,
  }],
  problems: [],
})

afterEach(() => {
  document.documentElement.removeAttribute('data-dr-theme')
  document.documentElement.classList.remove('dark')
  vi.unstubAllGlobals()
})

function show() {
  return render(<MemoryRouter><RuntimeFlowTopology snapshot={sample()} selectedStreamId={1} /></MemoryRouter>)
}

describe('Runtime graph Product Foundation theme + motion preference', () => {
  it('follows manual product dark/light theme changes rather than the OS color preference', async () => {
    document.documentElement.setAttribute('data-dr-theme', 'light')
    show()
    expect(screen.getByTestId('runtime-react-flow-theme')).toHaveTextContent('light')
    act(() => document.documentElement.setAttribute('data-dr-theme', 'dark'))
    await waitFor(() => expect(screen.getByTestId('runtime-react-flow-theme')).toHaveTextContent('dark'))
    act(() => document.documentElement.setAttribute('data-dr-theme', 'light'))
    await waitFor(() => expect(screen.getByTestId('runtime-react-flow-theme')).toHaveTextContent('light'))
  })

  it('disables motion even with current delivered EPS when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    show()
    expect(screen.getByTestId('runtime-react-flow-theme')).toHaveAttribute('data-active', '0')
    expect(screen.getByText(/Reduced motion/)).toBeInTheDocument()
  })
})
