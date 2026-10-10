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

describe('Mobile delivery evidence integrity on unreliable state', () => {
  function smallViewport(run: () => void) {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try { run() } finally { vi.unstubAllGlobals() }
  }

  it('does not equate an invalid-time snapshot with verified zero Route configuration', () => {
    smallViewport(() => {
      const s = evidence()
      s.global.total_routes = 0
      s.routes = []
      s.updated_at = 'not-a-timestamp'
      mount(s)
      expect(screen.getByTestId('routes-flow-inventory-state')).toHaveTextContent('Route inventory not verified')
      expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
    })
  })

  it('never labels a disabled delivery Route as healthy, even if old metrics were green', () => {
    smallViewport(() => {
      const s = evidence()
      s.routes = [{ ...s.routes[0]!, enabled: false, health_status: 'HEALTHY' }]
      mount(s)
      const badge = screen.getByTestId('routes-flow-mobile-health-42')
      expect(badge).toHaveTextContent(/^Disabled$/)
      expect(badge).not.toHaveClass('text-emerald-700')
      expect(screen.getByRole('link', { name: 'Investigate R-0042 delivery logs' })).toHaveAttribute(
        'href', '/logs?route_id=42&stream_id=1&destination_id=10',
      )
    })
  })
})

describe('Compact Route Flow at large Stream cardinality', () => {
  it('bounds mobile Stream cards to 12, then reveals next 20 on request', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const baseline = evidence()
      const ids = Array.from({ length: 30 }, (_, i) => i + 1)
      const s: OperationalSnapshotResponse = {
        ...baseline,
        global: { ...baseline.global, total_streams: 30, total_routes: 30 },
        streams: ids.map((id) => ({
          ...baseline.streams[0]!, stream_id: id, stream_name: `Mobile Stream ${id}`,
        })),
        routes: ids.map((id) => ({
          ...baseline.routes[0]!, route_id: id + 100, stream_id: id,
          stream_name: `Mobile Stream ${id}`, destination_id: id + 900,
        })),
      }
      mount(s)
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(12)
      expect(screen.getByRole('button', { name: 'Show next Streams (12 of 30 shown)' })).toBeInTheDocument()
      expect(screen.getByTestId('routes-flow-expanded-summary')).toHaveTextContent('8 of 30 Streams expanded')
      await user.click(screen.getByRole('button', { name: 'Show next Streams (12 of 30 shown)' }))
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(30)
      expect(screen.queryByRole('button', { name: /Show next Streams/ })).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})


describe('Compact Route Flow name and stable-ID investigation', () => {
  it('finds a Stream beyond the initial 12 cards by its numeric ID without loading new data', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const one = evidence()
      const ids = Array.from({ length: 120 }, (_, index) => index + 1)
      const many: OperationalSnapshotResponse = {
        ...one,
        global: { ...one.global, total_streams: 120, total_routes: 120 },
        streams: ids.map((id) => ({
          ...one.streams[0]!, stream_id: id, stream_name: `Finance ${id}`,
        })),
        routes: ids.map((id) => ({
          ...one.routes[0]!, route_id: id + 100, stream_id: id,
          stream_name: `Finance ${id}`, destination_id: id + 900,
        })),
      }
      mount(many)
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(12)
      await user.type(screen.getByRole('searchbox', { name: 'Find Stream, Route or Destination' }), '115')
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(1)
      expect(screen.getByTestId('routes-flow-mobile-stream-115')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Finance 115' })).toHaveAttribute('href', '/streams/115/runtime')
      expect(screen.queryByRole('button', { name: /Show next Streams/ })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Expand Finance 115 routes' }))
      expect(screen.getByRole('link', { name: 'R-0215' })).toHaveAttribute('href', '/routes/215/edit')
      await user.clear(screen.getByRole('searchbox', { name: 'Find Stream, Route or Destination' }))
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(12)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports zero search matches without calling a source inventory empty or healthy', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      mount(evidence())
      await user.type(screen.getByRole('searchbox', { name: 'Find Stream, Route or Destination' }), 'not-listed')
      expect(screen.getByRole('status', { name: 'Flow search result' })).toHaveTextContent('No matching Streams')
      expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
      expect(screen.queryByText('Route inventory not verified')).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Compact Route Flow investigation by saved Route and Destination identity', () => {
  it('finds a rare Route by its stable ID across 120 Streams, without mounting every Stream', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const baseline = evidence()
      const ids = Array.from({ length: 120 }, (_, index) => index + 1)
      const many: OperationalSnapshotResponse = {
        ...baseline,
        global: { ...baseline.global, total_streams: 120, total_routes: 120 },
        streams: ids.map((id) => ({
          ...baseline.streams[0]!, stream_id: id, stream_name: 'Finance ' + id,
        })),
        routes: ids.map((id) => ({
          ...baseline.routes[0]!, route_id: id + 100, stream_id: id,
          stream_name: 'Finance ' + id, destination_id: id + 900,
        })),
      }
      mount(many)
      const search = screen.getByRole('searchbox', { name: 'Find Stream, Route or Destination' })
      await user.type(search, 'R-0215')
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(1)
      expect(screen.getByRole('link', { name: 'Finance 115' })).toHaveAttribute('href', '/streams/115/runtime')
      await user.click(screen.getByRole('button', { name: 'Expand Finance 115 routes' }))
      expect(screen.getByRole('link', { name: 'R-0215' })).toHaveAttribute('href', '/routes/215/edit')
      expect(screen.getByRole('link', { name: 'Investigate R-0215 delivery logs' })).toHaveAttribute(
        'href', '/logs?route_id=215&stream_id=115&destination_id=1015',
      )
      await user.clear(search)
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(12)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('finds a receiver beyond the first 12 of 140 Routes while preserving true Stream route count', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const baseline = evidence()
      const routes = Array.from({ length: 140 }, (_, index) => ({
        ...baseline.routes[0]!,
        route_id: index + 1,
        destination_id: index + 1001,
        destination_name: index === 139 ? 'Rare SIEM Receiver' : 'Sink ' + (index + 1),
      }))
      const many: OperationalSnapshotResponse = {
        ...baseline,
        global: { ...baseline.global, total_routes: 140 },
        streams: [{ ...baseline.streams[0]!, route_count: 140 }],
        routes,
      }
      mount(many)
      const search = screen.getByRole('searchbox', { name: 'Find Stream, Route or Destination' })
      await user.type(search, 'Rare SIEM Receiver')
      expect(screen.getByRole('link', { name: 'R-0140' })).toHaveAttribute('href', '/routes/140/edit')
      expect(screen.getByRole('link', { name: 'View Rare SIEM Receiver destination' }))
        .toHaveAttribute('href', '/destinations/1140')
      expect(screen.getByTestId('routes-flow-mobile-stream-1')).toHaveTextContent('140 Routes')
      expect(screen.getByTestId('routes-flow-mobile-stream-1')).toHaveTextContent('1 matching Route')
      expect(screen.queryByRole('button', { name: /Show next Routes/ })).not.toBeInTheDocument()
      await user.clear(search)
      expect(screen.getAllByRole('link', { name: /^R-\d+$/ })).toHaveLength(12)
      expect(screen.getByRole('button', { name: 'Show next Routes (12 of 140 shown)' })).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Mobile Route Flow attention triage without extra backend reads', () => {
  it('surfaces enabled Error and Warning delivery paths outside the first 12 Stream cards', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const baseline = evidence()
      const ids = Array.from({ length: 30 }, (_, index) => index + 1)
      const snapshot = {
        ...baseline,
        global: { ...baseline.global, total_streams: 30, total_routes: 30 },
        streams: ids.map((id) => ({ ...baseline.streams[0]!, stream_id: id, stream_name: 'Finance ' + id })),
        routes: ids.map((id) => ({
          ...baseline.routes[0]!, route_id: id + 100, stream_id: id,
          stream_name: 'Finance ' + id, destination_id: 1000 + id,
          health_status: id === 1 || id === 21 ? 'ERROR' : id === 28 ? 'DEGRADED' : 'HEALTHY',
          enabled: id !== 21,
        })),
      } as OperationalSnapshotResponse
      mount(snapshot)
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(12)
      const button = screen.getByRole('button', { name: 'Show only enabled Routes needing attention' })
      await user.click(button)
      expect(button).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(2)
      expect(screen.getByTestId('routes-flow-mobile-stream-1')).toBeInTheDocument()
      expect(screen.getByTestId('routes-flow-mobile-stream-28')).toBeInTheDocument()
      expect(screen.queryByTestId('routes-flow-mobile-stream-21')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Expand Finance 28 routes' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Expand Finance 28 routes' }))
      expect(screen.getByTestId('routes-flow-mobile-health-128')).toHaveTextContent('Warning')
      expect(screen.getByRole('link', { name: 'Investigate R-0128 delivery logs' }))
        .toHaveAttribute('href', '/logs?route_id=128&stream_id=28&destination_id=1028')
      await user.click(button)
      expect(button).toHaveAttribute('aria-pressed', 'false')
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/)).toHaveLength(12)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('distinguishes no reported issues from missing inventory or proof of receiver ingestion', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const s = evidence()
      mount(s)
      await user.click(screen.getByRole('button', { name: 'Show only enabled Routes needing attention' }))
      const result = screen.getByRole('status', { name: 'Route attention filter result' })
      expect(result).toHaveTextContent('No enabled Error or Warning Routes reported')
      expect(result).toHaveTextContent('not proof of receiver ingestion')
      expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Attention-first mobile delivery order', () => {
  it('places enabled Errors before Warnings across both Streams and Routes', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    try {
      const s = evidence()
      s.global.total_streams = 2
      s.global.total_routes = 3
      s.streams = [
        { ...s.streams[0]!, stream_id: 1, stream_name: 'Warning Stream' },
        { ...s.streams[0]!, stream_id: 2, stream_name: 'Error Stream' },
      ]
      s.routes = [
        { ...s.routes[0]!, route_id: 42, stream_id: 1, stream_name: 'Warning Stream', health_status: 'DEGRADED' },
        { ...s.routes[0]!, route_id: 44, stream_id: 2, stream_name: 'Error Stream', health_status: 'DEGRADED' },
        { ...s.routes[0]!, route_id: 45, stream_id: 2, stream_name: 'Error Stream', health_status: 'ERROR' },
      ]
      mount(s)
      await user.click(screen.getByRole('button', { name: 'Show only enabled Routes needing attention' }))
      expect(screen.getAllByTestId(/^routes-flow-mobile-stream-/).map((card) => card.getAttribute('data-testid'))).toEqual([
        'routes-flow-mobile-stream-2',
        'routes-flow-mobile-stream-1',
      ])
      expect(screen.getAllByRole('link', { name: /^R-\d+$/ }).map((link) => link.textContent)).toEqual([
        'R-0045', 'R-0044', 'R-0042',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('REA-informed expert Route Flow indexed find', () => {
  it('reveals a Route by exact public ID outside the first eight Streams without mounting unrelated groups', async () => {
    const user = userEvent.setup()
    const s = evidence()
    const ids = Array.from({ length: 36 }, (_, i) => i + 1)
    s.global.total_streams = ids.length
    s.global.total_routes = ids.length
    s.streams = ids.map((id) => ({
      ...s.streams[0]!, stream_id: id, stream_name: `Tenant Flow ${id}`,
    }))
    s.routes = ids.map((id) => ({
      ...s.routes[0]!, route_id: 100 + id, stream_id: id,
      stream_name: `Tenant Flow ${id}`, destination_id: 900 + id,
      destination_name: `Receiver ${id}`,
    }))
    mount(s)
    expect(screen.queryByRole('link', { name: 'R-0136' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Find in expert Route Flow' }), 'R-0136')
    expect(screen.getByRole('link', { name: 'R-0136' })).toHaveAttribute('href', '/routes/136/edit')
    expect(screen.getByRole('link', { name: 'Tenant Flow 36' })).toHaveAttribute('href', '/streams/36/runtime')
    expect(screen.getByRole('link', { name: 'Investigate R-0136 delivery logs' }))
      .toHaveAttribute('href', '/logs?route_id=136&stream_id=36&destination_id=936')
    expect(screen.queryByRole('link', { name: 'R-0101' })).not.toBeInTheDocument()
    expect(screen.getByTestId('routes-flow-expert-find-status')).toHaveTextContent('1 matching Stream')
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
  })

  it('finds an exact Destination by name and a Route beyond the first twelve Route rows', async () => {
    const user = userEvent.setup()
    const s = evidence()
    s.global.total_routes = 60
    s.streams = [{ ...s.streams[0]!, route_count: 60 }]
    s.routes = Array.from({ length: 60 }, (_, i) => ({
      ...s.routes[0]!,
      route_id: i + 1,
      destination_id: 1000 + i,
      destination_name: i === 56 ? 'Cold Archive East' : `Receiver ${i + 1}`,
    }))
    mount(s)
    expect(screen.queryByRole('link', { name: 'R-0057' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Find in expert Route Flow' }), 'Cold Archive East')
    expect(screen.getByRole('link', { name: 'R-0057' })).toHaveAttribute('href', '/routes/57/edit')
    expect(screen.getByRole('link', { name: 'View Cold Archive East destination' }))
      .toHaveAttribute('href', '/destinations/1056')
    expect(screen.queryByRole('link', { name: 'R-0001' })).not.toBeInTheDocument()
  })

  it('searches by exact Stream ID first and preserves a manually collapsed Stream after clearing search', async () => {
    const user = userEvent.setup()
    mount(evidence())
    await user.click(screen.getByRole('button', { name: 'Collapse Finance flow routes' }))
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Find in expert Route Flow' }), '1')
    expect(screen.getByRole('link', { name: 'R-0042' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear expert Route search' }))
    expect(screen.getByRole('button', { name: 'Expand Finance flow routes' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'R-0042' })).not.toBeInTheDocument()
  })

  it('reports no matches only within loaded inventory, never a new empty installation', async () => {
    const user = userEvent.setup()
    mount(evidence())
    await user.type(screen.getByRole('searchbox', { name: 'Find in expert Route Flow' }), 'no-receiver-by-this-name')
    const message = screen.getByTestId('routes-flow-no-expert-matches')
    expect(message).toHaveTextContent('No matching Streams, Routes or Destinations')
    expect(message).toHaveTextContent('loaded snapshot')
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear expert Route search' }))
    expect(screen.getByRole('link', { name: 'Finance flow' })).toBeInTheDocument()
  })

  it('does not turn an unavailable runtime snapshot into search results or claim a healthy Route', () => {
    mount(null)
    expect(screen.queryByRole('searchbox', { name: 'Find in expert Route Flow' })).not.toBeInTheDocument()
    expect(screen.getByTestId('routes-flow-inventory-state')).toHaveTextContent('Route inventory not verified')
    expect(screen.getByTestId('routes-flow-snapshot-status')).toHaveTextContent('Runtime snapshot unavailable')
  })
})
