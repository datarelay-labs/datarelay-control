import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
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

  it('keeps manually collapsed Stream rows collapsed while fresh snapshot metrics update', async () => {
    const user = userEvent.setup()
    const first = evidence()
    const view = mount(first)
    await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
    const refreshed = {
      ...first,
      updated_at: new Date().toISOString(),
      streams: first.streams.map((s) => ({ ...s, eps_1m: 18 })),
      routes: first.routes.map((route) => ({ ...route, delivered_eps_1m: 12 })),
    }
    view.rerender(
      <MemoryRouter>
        <RoutesFlowTreeTable snapshot={refreshed} consoleRows={buildRouteRowsFromOperationalSnapshot(refreshed)} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Expand Finance flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Finance flow' })).toHaveAttribute('href', '/streams/1/runtime')
  })

  it('remembers a collapsed Stream through an unavailable snapshot and recovery', async () => {
    const user = userEvent.setup()
    const s = evidence()
    const view = mount(s)
    await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
    view.rerender(<MemoryRouter><RoutesFlowTreeTable snapshot={null} consoleRows={[]} loading /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
    const recovered = { ...s, updated_at: new Date().toISOString() }
    view.rerender(
      <MemoryRouter>
        <RoutesFlowTreeTable snapshot={recovered} consoleRows={buildRouteRowsFromOperationalSnapshot(recovered)} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Expand Finance flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
  })

  it('adds a newly discovered Stream without reopening an operator-collapsed existing Stream', async () => {
    const user = userEvent.setup()
    const first = evidence()
    const view = mount(first)
    await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
    const second = {
      ...first,
      global: { ...first.global, total_streams: 2, total_routes: 2 },
      streams: [...first.streams, { ...first.streams[0]!, stream_id: 2, stream_name: 'Audit flow', connector_id: 4 }],
      routes: [...first.routes, { ...first.routes[0]!, route_id: 43, stream_id: 2, stream_name: 'Audit flow' }],
    }
    view.rerender(
      <MemoryRouter>
        <RoutesFlowTreeTable snapshot={second} consoleRows={buildRouteRowsFromOperationalSnapshot(second)} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Expand Finance flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Collapse Audit flow routes' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'R-0043' })).toHaveAttribute('href', '/routes/43/edit')
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
  })

  it('bounds initial expanded Route rows at eight Streams and offers explicit expand all', async () => {
    const user = userEvent.setup()
    const base = evidence()
    const indices = Array.from({ length: 30 }, (_, i) => i)
    const many = {
      ...base,
      global: { ...base.global, total_streams: 30, total_routes: 30 },
      streams: indices.map((i) => ({
        ...base.streams[0]!,
        stream_id: i + 1,
        stream_name: `Collection ${i + 1}`,
        connector_id: i + 1,
      })),
      routes: indices.map((i) => ({
        ...base.routes[0]!,
        route_id: i + 101,
        stream_id: i + 1,
        stream_name: `Collection ${i + 1}`,
        destination_id: i + 901,
      })),
    }
    mount(many)
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(8)
    expect(screen.getByTestId('routes-flow-expanded-summary')).toHaveTextContent('8 of 30 Streams expanded')
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(30)
    expect(screen.getByTestId('routes-flow-expanded-summary')).toHaveTextContent('30 of 30 Streams expanded')
    await user.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByRole('link', { name: /^R-\d+$/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('routes-flow-expanded-summary')).toHaveTextContent('0 of 30 Streams expanded')
  })

  it('preserves explicit collapse-all preference when a new Stream arrives', async () => {
    const user = userEvent.setup()
    const first = evidence()
    const view = mount(first)
    await user.click(screen.getByRole('button', { name: 'Collapse all' }))
    const second = {
      ...first,
      global: { ...first.global, total_streams: 2, total_routes: 2 },
      streams: [...first.streams, { ...first.streams[0]!, stream_id: 2, stream_name: 'Audit flow' }],
      routes: [...first.routes, { ...first.routes[0]!, route_id: 43, stream_id: 2, stream_name: 'Audit flow' }],
    }
    view.rerender(
      <MemoryRouter>
        <RoutesFlowTreeTable snapshot={second} consoleRows={buildRouteRowsFromOperationalSnapshot(second)} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Expand Finance flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Expand Audit flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('routes-flow-expanded-summary')).toHaveTextContent('0 of 2 Streams expanded')
  })

  it('renders a bounded first 12 Routes and allows bounded progressive inspection of 55 Routes', async () => {
    const user = userEvent.setup()
    const base = evidence()
    const many = {
      ...base,
      global: { ...base.global, total_routes: 55 },
      streams: [{ ...base.streams[0]!, route_count: 55 }],
      routes: Array.from({ length: 55 }, (_, i) => ({
        ...base.routes[0]!, route_id: i + 1, destination_id: 901 + i,
      })),
    }
    mount(many)
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(12)
    expect(screen.getByRole('button', { name: 'Show next Routes (12 of 55 shown)' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'R-0055' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show next Routes (12 of 55 shown)' }))
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(32)
    await user.click(screen.getByRole('button', { name: 'Show next Routes (32 of 55 shown)' }))
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(52)
    await user.click(screen.getByRole('button', { name: 'Show next Routes (52 of 55 shown)' }))
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(55)
    expect(screen.queryByRole('button', { name: /Show next Routes/ })).not.toBeInTheDocument()
  })

  it('preserves inspected route page count when Stream is collapsed and snapshot refreshes', async () => {
    const user = userEvent.setup()
    const base = evidence()
    const many = {
      ...base,
      global: { ...base.global, total_routes: 48 },
      streams: [{ ...base.streams[0]!, route_count: 48 }],
      routes: Array.from({ length: 48 }, (_, i) => ({
        ...base.routes[0]!, route_id: i + 1, destination_id: 901 + i,
      })),
    }
    const view = mount(many)
    await user.click(screen.getByRole('button', { name: 'Show next Routes (12 of 48 shown)' }))
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(32)
    await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
    const refreshed = {
      ...many, updated_at: new Date().toISOString(),
      routes: many.routes.map((r) => ({ ...r, delivered_eps_1m: 5 })),
    }
    view.rerender(
      <MemoryRouter>
        <RoutesFlowTreeTable snapshot={refreshed} consoleRows={buildRouteRowsFromOperationalSnapshot(refreshed)} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: 'R-0001' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expand Finance flow routes' }))
    expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(32)
    expect(screen.getByRole('button', { name: 'Show next Routes (32 of 48 shown)' })).toBeInTheDocument()
  })

  it('loading from an unverified snapshot does not declare there are no Routes', () => {
    mount(null, true)
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
  })
})

describe('Flow-First compact mobile Route delivery', () => {
  function onSmallViewport<T>(run: () => T): T {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      return run()
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('shows touch-friendly Stream and Route evidence cards instead of a six-column table', async () => {
    const user = userEvent.setup()
    await onSmallViewport(async () => {
      mount(evidence())
      expect(screen.getByRole('region', { name: 'Compact route delivery' })).toBeInTheDocument()
      expect(screen.queryByRole('table', { name: 'Expert Route delivery table' })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Finance flow' })).toHaveAttribute('href', '/streams/1/runtime')
      expect(screen.getByRole('link', { name: 'R-0042' })).toHaveAttribute('href', '/routes/42/edit')
      expect(screen.getByRole('link', { name: 'Investigate R-0042 delivery logs' })).toHaveAttribute(
        'href', '/logs?route_id=42&stream_id=1&destination_id=10',
      )
      expect(screen.getByRole('link', { name: 'View Analytics sink destination' })).toHaveAttribute('href', '/destinations/10')
      expect(screen.getByTestId('routes-flow-mobile-health-42')).toHaveTextContent('Healthy')
      expect(screen.getByText(/downstream receiver ingestion not confirmed/i)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
      expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Expand Finance flow routes' }))
      expect(screen.getByRole('link', { name: 'R-0042' })).toBeInTheDocument()
    })
  })

  it('explains unverified inventory and refuses to declare a healthy Route on invalid or stale snapshots', () => {
    onSmallViewport(() => {
      const noSnapshot = mount(null)
      expect(screen.getByTestId('routes-flow-inventory-state')).toHaveTextContent('Route inventory not verified')
      expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
      noSnapshot.unmount()

      const stale = evidence()
      stale.updated_at = '2026-01-01T00:00:00Z'
      const view = mount(stale)
      expect(screen.getByTestId('routes-flow-mobile-health-42')).toHaveTextContent('Last reported Healthy')
      view.unmount()

      const invalidTime = evidence()
      invalidTime.updated_at = 'not-a-timestamp'
      mount(invalidTime)
      expect(screen.getByTestId('routes-flow-mobile-health-42')).toHaveTextContent('Unverified')
      expect(screen.getByTestId('routes-flow-snapshot-status')).toHaveTextContent('Snapshot time not verified')
    })
  })

  it('progressively reveals 12 then 32 of 55 delivery routes without mounting every mobile card', async () => {
    const user = userEvent.setup()
    await onSmallViewport(async () => {
      const s = evidence()
      s.global.total_routes = 55
      s.streams = [{ ...s.streams[0]!, route_count: 55 }]
      s.routes = Array.from({ length: 55 }, (_, i) => ({
        ...s.routes[0]!,
        route_id: i + 1,
        destination_id: i + 901,
      }))
      mount(s)
      expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(12)
      await user.click(screen.getByRole('button', { name: 'Show next Routes (12 of 55 shown)' }))
      expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(32)
      await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
      expect(screen.queryByRole('link', { name: 'R-0032' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Expand Finance flow routes' }))
      expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(32)
      expect(screen.getByRole('button', { name: 'Show next Routes (32 of 55 shown)' })).toBeInTheDocument()
    })
  })
})
