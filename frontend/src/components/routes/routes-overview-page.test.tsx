import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistSession } from '../../auth/session'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { RoutesOverviewPage } from './routes-overview-page'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'

const operationalSnapshot: OperationalSnapshotResponse = {
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
    total_eps_1m: 4,
    total_eps_5m: 3,
    avg_latency_ms: 10,
    last_activity_at: '2026-05-22T12:00:00Z',
  },
  streams: [{ stream_id: 1, stream_name: 'S1', connector_id: 1, source_id: 1, enabled: true, status: 'RUNNING', health_status: 'HEALTHY', eps_1m: 4, eps_5m: 3, success_rate_5m: 100, failure_rate_5m: 0, avg_latency_ms: 10, route_count: 1, healthy_route_count: 1, failed_route_count: 0, last_success_at: null, last_error_at: null, last_error_message: null, checkpoint_updated_at: null, checkpoint_lag_seconds: null }],
  routes: [
    {
      route_id: 5,
      stream_id: 1,
      stream_name: 'S1',
      destination_id: 2,
      destination_name: 'D1',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      failure_policy: 'LOG_AND_CONTINUE',
      health_status: 'HEALTHY',
      delivered_eps_1m: 4,
      failed_eps_1m: 0,
      success_rate_5m: 100,
      retry_rate_5m: 0,
      avg_latency_ms: 10,
      last_success_at: '2026-05-22T12:00:00Z',
      last_error_at: null,
      last_error_message: null,
    },
  ],
  destinations: [
    {
      destination_id: 2,
      destination_name: 'D1',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      health_status: 'HEALTHY',
      inbound_eps_1m: 4,
      failed_eps_1m: 0,
      avg_latency_ms: 10,
      route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
    },
  ],
  problems: [],
  updated_at: '2026-05-22T12:00:00Z',
}

vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(),
}))

vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: vi.fn(),
  updateRoute: vi.fn(),
}))

vi.mock('../../api/gdcRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcRuntime')>()
  return {
    ...actual,
    fetchStreamRuntimeMetrics: vi.fn(),
    saveRuntimeRouteEnabledState: vi.fn(),
    searchRuntimeDeliveryLogs: vi.fn(),
  }
})

vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchDeliveryOutcomesByDestination: vi.fn(),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationById: vi.fn(),
  fetchDestinationsList: vi.fn(),
  testDestination: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(),
}))

describe('RoutesOverviewPage snapshot loading', () => {
  afterEach(() => clearTestSession())
  beforeEach(async () => {
    vi.clearAllMocks()
    const snap = await import('../../api/operationalSnapshot')
    const routes = await import('../../api/gdcRoutes')
    const streams = await import('../../api/gdcStreams')
    const destinations = await import('../../api/gdcDestinations')
    const runtime = await import('../../api/gdcRuntime')
    vi.mocked(snap.getOperationalSnapshot).mockResolvedValue(operationalSnapshot)
    vi.mocked(routes.fetchRoutesList).mockResolvedValue([
      {
        id: 5,
        stream_id: 1,
        destination_id: 2,
        enabled: true,
        failure_policy: 'LOG_AND_CONTINUE',
        formatter_config_json: {},
        rate_limit_json: { enabled: false },
        status: 'ENABLED',
      },
    ])
    vi.mocked(streams.fetchStreamsList).mockResolvedValue([
      { id: 1, name: 'S1', connector_id: 1, source_id: 1, status: 'RUNNING' },
    ])
    vi.mocked(destinations.fetchDestinationsList).mockResolvedValue([
      {
        id: 2,
        name: 'D1',
        destination_type: 'WEBHOOK_POST',
        enabled: true,
        config_json: {},
        rate_limit_json: {},
        created_at: null,
        updated_at: null,
        streams_using_count: 1,
        routes: [],
      },
    ])
    vi.mocked(runtime.fetchStreamRuntimeMetrics).mockResolvedValue(null)
  })

  it.each(['VIEWER', 'GOVERNANCE_AUDITOR'] as const)('does not offer %s the global Create Route action', async (role) => {
    persistTestSession(role)
    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
    expect(await screen.findByTestId('routes-architecture-inspector')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Create Route' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Route settings' })).toBeInTheDocument()
  })

  it.each(['ADMINISTRATOR', 'OPERATOR'] as const)('offers %s the global Create Route action', async (role) => {
    persistTestSession(role)
    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
    expect(await screen.findByTestId('routes-architecture-inspector')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create Route' })).toHaveAttribute('href', '/routes/new/edit')
  })

  it('removes the global creation action on live capability downgrade', async () => {
    persistTestSession('OPERATOR')
    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
    expect(await screen.findByTestId('routes-architecture-inspector')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create Route' })).toBeInTheDocument()
    act(() => persistSession({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      user: { username: 'operator', role: 'OPERATOR', status: 'ACTIVE', capabilities: { workspace_mutations: false } },
    }))
    expect(screen.queryByRole('link', { name: 'Create Route' })).not.toBeInTheDocument()
  })

  it('shows Route catalog load failure as an error instead of a false empty catalog', async () => {
    const routes = await import('../../api/gdcRoutes')
    vi.mocked(routes.fetchRoutesList).mockResolvedValueOnce(null)

    render(
      <MemoryRouter>
        <RoutesOverviewPage />
      </MemoryRouter>,
    )

    const alert = await screen.findByTestId('routes-load-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent(/Could not load the Route catalog/i)
    expect(alert).toHaveTextContent(/retry before making Route decisions/i)
    expect(screen.queryByText('No routes configured yet.')).not.toBeInTheDocument()
  })

  it('labels retained Route metrics as last reported when the snapshot is stale', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    vi.mocked(snapshots.getOperationalSnapshot).mockResolvedValue({
      ...operationalSnapshot,
      routes: [{ ...operationalSnapshot.routes[0]!, success_rate_5m: 40 }],
    })

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)

    const evidence = await screen.findByTestId('routes-snapshot-evidence')
    expect(evidence).toHaveTextContent('Stale snapshot · last reported')
    expect(screen.getByRole('region', { name: 'Route KPI summary' }))
      .toHaveTextContent('Last reported metrics · current values not verified')
    const problemRoutes = screen.getByRole('region', { name: 'Problem routes' })
    expect(problemRoutes).toHaveTextContent('Last reported Route conditions')
    expect(problemRoutes).toHaveTextContent('Last reported Low Success Rate')
    expect(screen.getByRole('region', { name: 'Route metrics by destination' }))
      .toHaveTextContent('Last reported destination metrics')
    expect(screen.getByTestId('routes-architecture-selected-collection-health'))
      .toHaveTextContent('Stale')
  })

  it('does not present a fresh-looking snapshot when Route catalog refresh failed', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    const routes = await import('../../api/gdcRoutes')
    vi.mocked(snapshots.getOperationalSnapshot).mockResolvedValue({
      ...operationalSnapshot,
      updated_at: new Date().toISOString(),
      routes: [{
        ...operationalSnapshot.routes[0]!,
        health_status: 'DEGRADED',
      }],
    })
    vi.mocked(routes.fetchRoutesList).mockResolvedValueOnce(null)

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)

    await screen.findByTestId('routes-load-error')
    const evidence = await screen.findByTestId('routes-snapshot-evidence')
    expect(evidence).toHaveTextContent('Unverified · last reported')
    expect(screen.getByTestId('routes-architecture-selected-collection-health'))
      .toHaveTextContent('Stale')
    expect(screen.getByRole('region', { name: 'Problem routes' }))
      .toHaveTextContent('Last reported Route conditions')
  })

  it('does not report zero Streams or Routes when the runtime snapshot cannot be read', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    vi.mocked(snapshots.getOperationalSnapshot).mockResolvedValueOnce(null)

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)

    await screen.findByTestId('routes-load-error')
    const kpis = screen.getByRole('region', { name: 'Route KPI summary' })
    expect(kpis).toHaveTextContent('Runtime metrics not verified')
    const streamCard = within(kpis).getByTestId('routes-kpi-total-streams')
    const routeCard = within(kpis).getByTestId('routes-kpi-total-routes')
    expect(streamCard).toHaveTextContent('—')
    expect(streamCard).toHaveTextContent('Not verified')
    expect(streamCard).not.toHaveTextContent('0 running')
    expect(routeCard).toHaveTextContent('—')
    expect(routeCard).not.toHaveTextContent('0 enabled')
    expect(kpis).not.toHaveTextContent('0 /s')
    expect(kpis.querySelector('svg')).toBeNull()
    expect(screen.getByText('All Routes (—)')).toBeInTheDocument()
  })

  it('retains measured zero counts when an empty runtime snapshot is fresh', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    vi.mocked(snapshots.getOperationalSnapshot).mockResolvedValueOnce({
      ...operationalSnapshot,
      updated_at: new Date().toISOString(),
      global: { ...operationalSnapshot.global, total_streams: 0,
        enabled_streams: 0, running_streams: 0, total_routes: 0, enabled_routes: 0,
        total_destinations: 0, enabled_destinations: 0, total_eps_1m: 0, total_eps_5m: 0 },
      streams: [], routes: [], destinations: [], problems: [],
    })
    vi.mocked((await import('../../api/gdcRoutes')).fetchRoutesList).mockResolvedValueOnce([])

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)

    await screen.findByTestId('routes-snapshot-evidence')
    const kpis = screen.getByRole('region', { name: 'Route KPI summary' })
    expect(within(kpis).getByTestId('routes-kpi-total-streams')).toHaveTextContent('0 running')
    expect(within(kpis).getByTestId('routes-kpi-total-routes')).toHaveTextContent('0 enabled')
    expect(kpis).not.toHaveTextContent('Runtime metrics not verified')
    expect(screen.getByText('All Routes (0)')).toBeInTheDocument()
    expect(screen.getByTestId('routes-snapshot-evidence')).toHaveTextContent('SNAPSHOT')
  })

  it('uses an unverified empty state without a snapshot, then restores current evidence on refresh', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    vi.mocked(snapshots.getOperationalSnapshot)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...operationalSnapshot, updated_at: new Date().toISOString() })

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)

    await screen.findByTestId('routes-load-error')
    expect(screen.getByRole('region', { name: 'Problem routes' }))
      .toHaveTextContent('Route issues not verified · runtime snapshot unavailable.')
    expect(screen.getByRole('region', { name: 'Route metrics by destination' }))
      .toHaveTextContent('Destination delivery not verified · runtime snapshot unavailable.')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    const evidence = await screen.findByTestId('routes-snapshot-evidence')
    expect(evidence).toHaveTextContent('SNAPSHOT')
    expect(screen.queryByTestId('routes-load-error')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Problem routes' }))
      .toHaveTextContent('Current health warnings and errors')
  })

  it('expires the current snapshot evidence at 90 seconds without a network refresh', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    const observedAt = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(observedAt)
    try {
      vi.mocked(snapshots.getOperationalSnapshot).mockResolvedValue({
        ...operationalSnapshot,
        updated_at: new Date(observedAt).toISOString(),
      })
      render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
      const evidence = await screen.findByTestId('routes-snapshot-evidence')
      expect(evidence).toHaveTextContent('SNAPSHOT')
      expect(screen.getByRole('region', { name: 'Problem routes' }))
        .toHaveTextContent('Current health warnings and errors')

      act(() => {
        dateNow.mockReturnValue(observedAt + 90_001)
        window.dispatchEvent(new Event('focus'))
      })

      expect(evidence).toHaveTextContent('Stale snapshot · last reported')
      expect(screen.getByRole('region', { name: 'Problem routes' }))
        .toHaveTextContent('Last reported Route conditions')
      expect(snapshots.getOperationalSnapshot).toHaveBeenCalledTimes(1)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('keeps one primary action in the Data Flows view', async () => {
    persistTestSession('ADMINISTRATOR')
    const { container } = render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
    expect(await screen.findByTestId('routes-architecture-inspector')).toBeInTheDocument()
    const primaries = container.querySelectorAll('button.bg-accent, a.bg-accent')
    expect(primaries).toHaveLength(1)
    expect(primaries[0]).toBe(screen.getByRole('link', { name: 'Create Route' }))
    for (const name of ['Configure Route in workspace']) {
      expect(screen.getByRole('button', { name })).not.toHaveClass('bg-accent')
    }
    expect(screen.getByRole('link', { name: 'Open full Route editor' })).toHaveClass('bg-transparent')
  })

  it('merges the Delivery architecture header into one SectionHeader without a gradient or eyebrow', async () => {
    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
    const workspace = await screen.findByTestId('routes-architecture-workspace')
    expect(workspace.querySelector('[class*="bg-gradient"]')).toBeNull()
    expect(workspace).not.toHaveTextContent('Delivery workspace')
    expect(within(workspace).getByRole('heading', { level: 2, name: 'Delivery architecture' })).toBeInTheDocument()
    expect(within(workspace).getByTestId('routes-architecture-count-summary')).toBeInTheDocument()
  })

  it('renders unmeasured KPI values as unknown tiles, never as 0, 0% or 100%', async () => {
    const snapshots = await import('../../api/operationalSnapshot')
    vi.mocked(snapshots.getOperationalSnapshot).mockResolvedValueOnce(null)

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)

    await screen.findByTestId('routes-load-error')
    const kpis = screen.getByRole('region', { name: 'Route KPI summary' })
    for (const id of ['total-streams', 'total-routes', 'throughput', 'delivery-success', 'error-rate', 'latency']) {
      const tile = within(kpis).getByTestId('routes-kpi-' + id)
      const value = tile.querySelector('[data-metric-value]')
      expect(value, id).toHaveAttribute('data-unknown', 'true')
      expect(value, id).toHaveTextContent('—')
      expect(value, id).toHaveClass('text-status-unknown')
    }
    expect(kpis).not.toHaveTextContent('0%')
    expect(kpis).not.toHaveTextContent('100%')
  })

  it('loads operational snapshot on mount and does not fetch per-stream metrics', async () => {
    const snap = await import('../../api/operationalSnapshot')
    const runtime = await import('../../api/gdcRuntime')

    render(
      <MemoryRouter>
        <RoutesOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(snap.getOperationalSnapshot).toHaveBeenCalled()
    })
    // The read path always returns one current gateway snapshot, not metrics
    // for a user-selected 15m/1h/6h/24h window.
    expect(screen.queryByRole('combobox', { name: 'Metrics window' })).not.toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'Metrics time basis' })).toHaveTextContent(
      'Metrics basis: gateway throughput/errors 1m · delivery success 5m (weighted by 1m ingest) · latency 5m',
    )
    expect(screen.getByTestId('routes-purpose-header')).toHaveTextContent(/destination-specific path/i)
    expect(screen.getByTestId('routes-mental-model')).toHaveTextContent('Stream')
    expect(screen.getByTestId('routes-mental-model')).toHaveTextContent('Route Processing')
    expect(screen.getByTestId('routes-mental-model')).toHaveTextContent('Destination')
    expect(screen.getByTestId('routes-mental-model')).toHaveTextContent(/fan out through many Routes/i)
    expect(await screen.findByTestId('routes-architecture-workspace')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Delivery architecture' })).toBeInTheDocument()
    expect(screen.getByTestId('routes-architecture-stream-1')).toHaveTextContent('S1')
    expect(screen.getByTestId('routes-architecture-route-5')).toHaveTextContent('Route')
    expect(screen.getByTestId('routes-architecture-destination-2')).toHaveTextContent('D1')
    expect(screen.getByTestId('routes-architecture-graph')).toHaveTextContent('Connector #1')
    expect(screen.getByTestId('routes-architecture-graph')).toHaveTextContent('Source #1')
    const inspector = screen.getByTestId('routes-architecture-inspector')
    expect(inspector).toHaveTextContent('Receiver-confirmed ingestion')
    expect(inspector).toHaveTextContent('Not verified by this snapshot')
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: 'Delivery' }))
    expect(inspector).toHaveTextContent('Retry rate (5m)')
    await user.click(screen.getByRole('tab', { name: 'Diagnostics' }))
    expect(inspector).toHaveTextContent('Failed output (1m)')
    expect(inspector).toHaveTextContent('Log and Continue')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Stale')
    expect(screen.getByText('Route Flow')).toBeInTheDocument()
    expect(screen.getByText('All Routes (1)')).toBeInTheDocument()
    expect(screen.getAllByText('S1').length).toBeGreaterThan(0)
    expect(runtime.fetchStreamRuntimeMetrics).not.toHaveBeenCalled()
  })

  it('explains the Stream to Route to Destination mental model in page help', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <RoutesOverviewPage />
      </MemoryRouter>,
    )
    await screen.findByText('Route Flow')
    await user.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('The core model')
    expect(screen.getByRole('dialog')).toHaveTextContent(/Each Route targets one Destination/i)
  })

  it('keeps duplicate-name streams independently selectable by stream ID', async () => {
    const user = userEvent.setup()
    const snap = await import('../../api/operationalSnapshot')
    const duplicateNameSnapshot: OperationalSnapshotResponse = {
      ...operationalSnapshot,
      global: {
        ...operationalSnapshot.global,
        total_streams: 2,
        enabled_streams: 2,
        running_streams: 2,
        total_routes: 2,
        enabled_routes: 2,
      },
      streams: [
        operationalSnapshot.streams[0]!,
        {
          ...operationalSnapshot.streams[0]!,
          stream_id: 2,
          stream_name: 'S1',
        },
      ],
      routes: [
        operationalSnapshot.routes[0]!,
        {
          ...operationalSnapshot.routes[0]!,
          route_id: 6,
          stream_id: 2,
          stream_name: 'S1',
        },
      ],
    }
    vi.mocked(snap.getOperationalSnapshot).mockResolvedValue(duplicateNameSnapshot)

    render(
      <MemoryRouter>
        <RoutesOverviewPage />
      </MemoryRouter>,
    )

    await screen.findByText('All Routes (2)')
    await user.click(screen.getByRole('button', { name: /All Routes \(2\)/i }))

    const streamSelect = screen.getByLabelText('Stream filter')
    expect(screen.getByRole('option', { name: 'S1 · #1' })).toHaveValue('1')
    expect(screen.getByRole('option', { name: 'S1 · #2' })).toHaveValue('2')

    await user.selectOptions(streamSelect, '2')

    expect(await screen.findByTestId('routes-architecture-graph')).toHaveTextContent('Stream #2')
    expect(screen.getByTestId('routes-architecture-route-6')).toBeInTheDocument()
    expect(screen.queryByTestId('routes-architecture-route-5')).not.toBeInTheDocument()
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('R-0006')
    expect(screen.getByTestId('routes-architecture-stream-1')).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    { latency: null, expected: '—' },
    { latency: 0, expected: '0 ms' },
    { latency: 180.4, expected: '180 ms' },
  ])('preserves unavailable and measured catalog latency ($latency)', async ({ latency, expected }) => {
    const user = userEvent.setup()
    const snap = await import('../../api/operationalSnapshot')
    const lastSuccessAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    vi.mocked(snap.getOperationalSnapshot).mockResolvedValue({
      ...operationalSnapshot,
      routes: [{
        ...operationalSnapshot.routes[0]!,
        avg_latency_ms: latency,
        last_success_at: lastSuccessAt,
      }],
    })

    render(<MemoryRouter><RoutesOverviewPage /></MemoryRouter>)
    await screen.findByText('All Routes (1)')
    await user.click(screen.getByRole('button', { name: /All Routes \(1\)/i }))

    const row = await screen.findByTestId('routes-table-row-5')
    const table = row.closest('table')!
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())
    const cells = within(row).getAllByRole('cell')
    expect(cells[headers.indexOf('Avg Latency')]?.textContent?.trim()).toBe(expected)
    expect(cells[headers.indexOf('Last Activity')]).toHaveTextContent(/^4h ago$/)
  })

  it('restores the exact Stream and Route selection from a Data Flows investigation deep link', async () => {
    const snap = await import('../../api/operationalSnapshot')
    const deepLinkSnapshot: OperationalSnapshotResponse = {
      ...operationalSnapshot,
      global: {
        ...operationalSnapshot.global,
        total_routes: 2,
        enabled_routes: 2,
      },
      streams: [
        {
          ...operationalSnapshot.streams[0]!,
          route_count: 2,
        },
      ],
      routes: [
        operationalSnapshot.routes[0]!,
        {
          ...operationalSnapshot.routes[0]!,
          route_id: 6,
          stream_id: 1,
          stream_name: 'S1',
        },
      ],
    }
    vi.mocked(snap.getOperationalSnapshot).mockResolvedValue(deepLinkSnapshot)

    render(
      <MemoryRouter initialEntries={['/routes?stream_id=1&route_id=6']}>
        <RoutesOverviewPage />
      </MemoryRouter>,
    )

    const inspector = await screen.findByTestId('routes-architecture-inspector')
    expect(inspector).toHaveTextContent('R-0006')
    expect(screen.getByTestId('routes-architecture-route-6')).toBeInTheDocument()
    expect(screen.getByTestId('routes-architecture-stream-1')).toHaveAttribute('aria-pressed', 'true')
  })
})
