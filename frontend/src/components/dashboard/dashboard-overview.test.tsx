import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DashboardOverview } from './dashboard-overview'
import type {
  DashboardSummaryResponse,
  HealthOverviewResponse,
  ObservabilitySummaryResponse,
  RetrySummaryResponse,
  RuntimeAlertSummaryResponse,
} from '../../api/types/gdcApi'

const sampleDashboard = (): DashboardSummaryResponse => ({
  summary: {
    total_streams: 10,
    running_streams: 7,
    paused_streams: 1,
    error_streams: 0,
    stopped_streams: 2,
    rate_limited_source_streams: 0,
    rate_limited_destination_streams: 1,
    total_routes: 12,
    enabled_routes: 11,
    disabled_routes: 1,
    total_destinations: 4,
    enabled_destinations: 4,
    disabled_destinations: 0,
    recent_logs: 120,
    processed_events: 1378,
    delivery_outcome_events: 1172,
    recent_successes: 100,
    recent_failures: 15,
    recent_rate_limited: 5,
    current_runtime_streams_healthy: 6,
    current_runtime_streams_degraded: 1,
  },
  recent_problem_routes: [],
  recent_rate_limited_routes: [],
  recent_unhealthy_streams: [],
  runtime_engine_status: 'RUNNING',
  active_worker_count: 2,
  metrics_window_seconds: 3600,
  metric_meta: {},
  open_schema_field_drift_count: 3,
})

const snapshotParam = (params?: { snapshot_id?: string }) => params?.snapshot_id ?? FIXED_SNAPSHOT

const FIXED_SNAPSHOT = '2026-01-01T01:00:00Z'

const sampleObservability = (snapshot_id = FIXED_SNAPSHOT): ObservabilitySummaryResponse => ({
  snapshot_id,
  generated_at: snapshot_id,
  window: '1h',
  window_start: '2026-01-01T00:00:00Z',
  window_end: '2026-01-01T01:00:00Z',
  metric_contract_version: 'v1',
  totals: {
    streams_total: 10,
    streams_running: 7,
    routes_total: 12,
    routes_enabled: 11,
    healthy_routes: 9,
    idle_routes: 1,
    unhealthy_routes: 1,
    delivery_success_events: 100,
    delivery_failed_events: 15,
    retry_success_events: 3,
    retry_failed_events: 1,
    runtime_telemetry_rows: 120,
    lifecycle_rows: 5,
    processed_events: 1378,
    throughput_eps: 0.033,
    p95_latency_ms: null,
  },
  metric_contract: {},
  metric_meta: {},
})

const sampleHealth = (snapshot_id = '2026-01-01T01:00:00Z'): HealthOverviewResponse => ({
  time: { window: '1h', since: '2026-01-01T00:00:00Z', until: '2026-01-01T01:00:00Z', snapshot_id },
  filters: { stream_id: null, route_id: null, destination_id: null },
  scoring_mode: 'current_runtime',
  streams: { healthy: 6, degraded: 1, unhealthy: 0, critical: 0, excluded_no_outcome: 2 },
  routes: { healthy: 9, degraded: 1, unhealthy: 1, critical: 0 },
  destinations: { healthy: 4, degraded: 0, unhealthy: 0, critical: 0 },
  average_stream_score: 82,
  average_route_score: 88,
  average_destination_score: 95,
  worst_routes: [],
  worst_streams: [],
  worst_destinations: [],
})

vi.mock('../../api/runtimeSnapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/runtimeSnapshotSync')>()
  return {
    ...actual,
    createRuntimeSnapshotId: () => '2026-01-01T01:00:00Z',
  }
})

vi.mock('../../api/gdcRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcRuntime')>()
  return {
    ...actual,
    fetchRuntimeDashboardSummary: vi.fn(async (_limit: number, _window: string, params?: { snapshot_id?: string }) => ({
      ...sampleDashboard(),
      snapshot_id: snapshotParam(params),
      generated_at: snapshotParam(params),
      window_start: '2026-01-01T00:00:00Z',
      window_end: '2026-01-01T01:00:00Z',
    })),
    fetchRuntimeDashboardOutcomeTimeseries: vi.fn(async (params?: { snapshot_id?: string }) => ({
      snapshot_id: snapshotParam(params),
      generated_at: snapshotParam(params),
      metrics_window_seconds: 3600,
      buckets: [
        { bucket_start: '2026-01-01T00:15:00Z', success: 40, failed: 5, rate_limited: 2 },
        { bucket_start: '2026-01-01T00:30:00Z', success: 55, failed: 3, rate_limited: 1 },
        { bucket_start: '2026-01-01T00:45:00Z', success: 48, failed: 7, rate_limited: 0 },
      ],
    })),
    fetchRuntimeAlertSummary: vi.fn(async (): Promise<RuntimeAlertSummaryResponse> => ({
      items: [
        {
          stream_id: 1,
          stream_name: 'Payment API Stream',
          connector_name: 'Payment API',
          severity: 'ERROR',
          count: 4,
          latest_occurrence: '2026-01-01T00:30:00Z',
        },
      ],
    })),
    invalidateDashboardAnalyticsCache: vi.fn(),
  }
})

vi.mock('../../api/gdcRuntimeHealth', () => ({
  fetchHealthOverview: vi.fn(async (params?: { snapshot_id?: string }) => sampleHealth(params?.snapshot_id)),
}))

vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchRetriesSummary: vi.fn(async (params?: { snapshot_id?: string }): Promise<RetrySummaryResponse> => ({
    time: {
      window: '1h',
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-01T01:00:00Z',
      snapshot_id: snapshotParam(params),
      generated_at: snapshotParam(params),
    },
    total_retry_outcome_events: 4,
    retry_success_events: 3,
    retry_failed_events: 1,
    retry_column_sum: 0,
  })),
}))

vi.mock('../../api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(async (_window: string, params?: { snapshot_id?: string }) =>
    sampleObservability(snapshotParam(params)),
  ),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => [
    { id: 1, name: 'Payment API Stream', connector_id: 10, source_id: 1, status: 'ERROR', enabled: true },
    { id: 2, name: 'Orders DB', connector_id: 11, source_id: 2, status: 'RUNNING', enabled: true },
  ]),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => [
    { id: 10, name: 'Payment API', product_group: 'Payment API', connector_type: 'generic_http', source_type: 'HTTP_API_POLLING' },
    { id: 11, name: 'MySQL Orders DB', product_group: 'MySQL Orders DB', connector_type: 'relational_database', source_type: 'DATABASE_QUERY' },
  ]),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  getOperationalSnapshot: vi.fn(async () => ({
    global: {
      health_status: 'DEGRADED',
      total_streams: 4,
      enabled_streams: 4,
      running_streams: 1,
      error_streams: 1,
      total_routes: 2,
      enabled_routes: 2,
      total_destinations: 2,
      enabled_destinations: 2,
      total_eps_1m: 150,
      total_eps_5m: 140,
      avg_latency_ms: 20,
      last_activity_at: null,
    },
    streams: [
      {
        stream_id: 1,
        stream_name: 'Payment API Stream',
        connector_id: 10,
        source_id: 1,
        enabled: true,
        status: 'ERROR',
        health_status: 'ERROR',
        eps_1m: 100,
        eps_5m: 95,
        success_rate_5m: 50,
        failure_rate_5m: 50,
        avg_latency_ms: 30,
        route_count: 1,
        healthy_route_count: 0,
        failed_route_count: 1,
        last_success_at: null,
        last_error_at: null,
        last_error_message: null,
        checkpoint_updated_at: null,
        checkpoint_lag_seconds: null,
      },
      {
        stream_id: 2,
        stream_name: 'Orders DB',
        connector_id: 11,
        source_id: 2,
        enabled: true,
        status: 'RUNNING',
        health_status: 'HEALTHY',
        eps_1m: 50,
        eps_5m: 45,
        success_rate_5m: 99,
        failure_rate_5m: 1,
        avg_latency_ms: 10,
        route_count: 1,
        healthy_route_count: 1,
        failed_route_count: 0,
        last_success_at: null,
        last_error_at: null,
        last_error_message: null,
        checkpoint_updated_at: null,
        checkpoint_lag_seconds: null,
      },
      {
        stream_id: 3,
        stream_name: 'Idle A',
        connector_id: 10,
        source_id: 3,
        enabled: true,
        status: 'IDLE',
        health_status: 'IDLE',
        eps_1m: 0,
        eps_5m: 0,
        success_rate_5m: 0,
        failure_rate_5m: 0,
        avg_latency_ms: null,
        route_count: 0,
        healthy_route_count: 0,
        failed_route_count: 0,
        last_success_at: null,
        last_error_at: null,
        last_error_message: null,
        checkpoint_updated_at: null,
        checkpoint_lag_seconds: null,
      },
      {
        stream_id: 4,
        stream_name: 'Idle B',
        connector_id: 11,
        source_id: 4,
        enabled: true,
        status: 'IDLE',
        health_status: 'IDLE',
        eps_1m: 0,
        eps_5m: 0,
        success_rate_5m: 0,
        failure_rate_5m: 0,
        avg_latency_ms: null,
        route_count: 0,
        healthy_route_count: 0,
        failed_route_count: 0,
        last_success_at: null,
        last_error_at: null,
        last_error_message: null,
        checkpoint_updated_at: null,
        checkpoint_lag_seconds: null,
      },
    ],
    routes: [],
    destinations: [],
    problems: [
      {
        severity: 'warning',
        scope: 'destination',
        stream_id: null,
        route_id: null,
        destination_id: 1,
        title: 'Capacity',
        message: 'Destination capacity warning',
        last_seen_at: null,
      },
    ],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))

vi.mock('../../api/gdcRetention', () => ({
  fetchRetentionStatus: vi.fn(async () => ({
    retention_enabled: true,
    supplement_next_after_utc: null,
    last_operational_retention_at: '2026-01-01T00:00:00Z',
    last_audit: null,
  })),
}))

function mainRegion() {
  return screen.getByRole('main')
}

describe('DashboardOverview', () => {
  it('shows loading state before data resolves', async () => {
    const rt = await import('../../api/gdcRuntime')
    vi.mocked(rt.fetchRuntimeDashboardSummary).mockImplementationOnce(
      () =>
        new Promise<DashboardSummaryResponse | null>((resolve) => {
          globalThis.setTimeout(() => resolve(sampleDashboard()), 40)
        }),
    )
    render(
      <MemoryRouter>
        <DashboardOverview />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('dashboard-loading')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('dashboard-loading')).not.toBeInTheDocument())
  })

  it('does not render a duplicate Dashboard page heading under App Shell', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    await within(mainRegion()).findByTestId('dashboard-first-level')
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.queryByText('© 2025 Data Relay Platform')).not.toBeInTheDocument()
    expect(screen.queryByText(/All times shown in UTC/i)).not.toBeInTheDocument()
  })

  it('renders exact first-level charter sections only', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const firstLevel = await within(mainRegion()).findByTestId('dashboard-first-level')
    expect(within(firstLevel).getByTestId('dashboard-overall-health-hero')).toBeInTheDocument()
    expect(within(firstLevel).getByTestId('dashboard-traffic-overview')).toBeInTheDocument()
    expect(within(firstLevel).getByTestId('dashboard-operational-issues')).toBeInTheDocument()
    expect(within(firstLevel).getByTestId('dashboard-drilldown')).toBeInTheDocument()

    expect(screen.queryByTestId('dashboard-overall-health-beacon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-system-health-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-kpi-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-stream-health-matrix')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-events-over-time')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-top-sources')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-recent-alerts')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-system-health')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-operational-problems')).not.toBeInTheDocument()
  })

  it('shows Healthy / Warning / Critical overall health counts', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const hero = await within(mainRegion()).findByTestId('dashboard-overall-health-hero')
    expect(within(hero).getByTestId('dashboard-overall-posture-label')).toHaveTextContent(/Critical|Warning|Healthy/)
    expect(within(hero).getByTestId('dashboard-health-healthy')).toBeInTheDocument()
    expect(within(hero).getByTestId('dashboard-health-warning')).toBeInTheDocument()
    expect(within(hero).getByTestId('dashboard-health-critical')).toBeInTheDocument()
  })

  it('shows Traffic Overview charter metrics', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const traffic = await within(mainRegion()).findByTestId('dashboard-traffic-overview')
    expect(within(traffic).getByText('Incoming Events')).toBeInTheDocument()
    expect(within(traffic).getByText('Outgoing Events')).toBeInTheDocument()
    expect(within(traffic).getByText('Delivery Success Rate')).toBeInTheDocument()
    expect(within(traffic).getByTestId('dashboard-traffic-incoming')).toHaveAttribute('href', '/streams')
    expect(within(traffic).getByTestId('dashboard-traffic-outgoing')).toHaveAttribute('href', '/destinations')
  })

  it('shows Operational Issues charter categories with warning state drill-downs', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const issues = await within(mainRegion()).findByTestId('dashboard-operational-issues')
    expect(within(issues).getByTestId('dashboard-issue-no-data')).toHaveAttribute('href', '/streams?filter=no-data')
    expect(within(issues).getByTestId('dashboard-issue-low-volume')).toHaveAttribute('href', '/streams?filter=low-volume')
    expect(within(issues).getByTestId('dashboard-issue-schema-drift')).toHaveAttribute('href', '/governance')
    expect(within(issues).getByTestId('dashboard-issue-destination-capacity')).toHaveAttribute(
      'href',
      '/destinations?filter=warning',
    )
    expect(within(issues).getByText('No Data Streams')).toBeInTheDocument()
    expect(within(issues).getByText('Schema Drift Count')).toBeInTheDocument()
    expect(within(issues).getByText('Destination Capacity Warning Count')).toBeInTheDocument()
    // Snapshot has 2 IDLE streams and 1 destination capacity warning
    expect(within(issues).getByTestId('dashboard-issue-no-data')).toHaveTextContent('2')
    expect(within(issues).getByTestId('dashboard-issue-destination-capacity')).toHaveTextContent('1')
    await waitFor(() => {
      expect(within(issues).getByTestId('dashboard-issue-schema-drift')).toHaveTextContent('3')
    })
  })

  it('exposes drill-down links to existing operational surfaces', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    expect(await within(mainRegion()).findByTestId('dashboard-drilldown-streams')).toHaveAttribute('href', '/streams')
    expect(within(mainRegion()).getByTestId('dashboard-drilldown-destinations')).toHaveAttribute('href', '/destinations')
    expect(within(mainRegion()).getByTestId('dashboard-drilldown-logs')).toHaveAttribute('href', '/logs')
    expect(within(mainRegion()).getByTestId('dashboard-drilldown-governance')).toHaveAttribute('href', '/governance')
  })

  it('shows fresh-install empty state with create-first-stream action', async () => {
    const snap = await import('../../api/operationalSnapshot')
    vi.mocked(snap.getOperationalSnapshot).mockResolvedValueOnce({
      global: {
        health_status: 'HEALTHY',
        total_streams: 0,
        enabled_streams: 0,
        running_streams: 0,
        error_streams: 0,
        total_routes: 0,
        enabled_routes: 0,
        total_destinations: 0,
        enabled_destinations: 0,
        total_eps_1m: 0,
        total_eps_5m: 0,
        avg_latency_ms: null,
        last_activity_at: null,
      },
      streams: [],
      routes: [],
      destinations: [],
      problems: [],
      updated_at: '2026-01-01T00:00:00Z',
    } as Awaited<ReturnType<typeof snap.getOperationalSnapshot>>)
    const streams = await import('../../api/gdcStreams')
    vi.mocked(streams.fetchStreamsList).mockResolvedValueOnce([])

    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const empty = await within(mainRegion()).findByTestId('dashboard-empty-state')
    expect(within(empty).getByText(/Welcome to Data Relay/i)).toBeInTheDocument()
    expect(within(empty).getByRole('link', { name: /Create First Stream/i })).toHaveAttribute('href', '/streams/new')
    expect(screen.queryByTestId('dashboard-first-level')).not.toBeInTheDocument()
  })

  it('shows load error when operational snapshot is unavailable', async () => {
    const snap = await import('../../api/operationalSnapshot')
    vi.mocked(snap.getOperationalSnapshot).mockResolvedValueOnce(null)

    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    expect(await within(mainRegion()).findByTestId('dashboard-load-error')).toHaveTextContent(/operational snapshot/i)
  })

  it('allows manual refresh from the toolbar', async () => {
    const user = userEvent.setup()
    const rt = await import('../../api/gdcRuntime')
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    await within(mainRegion()).findByTestId('dashboard-first-level')
    const before = vi.mocked(rt.fetchRuntimeDashboardSummary).mock.calls.length
    await user.click(screen.getByRole('button', { name: /Refresh dashboard data now/i }))
    await waitFor(() => {
      expect(vi.mocked(rt.fetchRuntimeDashboardSummary).mock.calls.length).toBeGreaterThan(before)
    })
  })

  it('does not render removed operations center widgets', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    await within(mainRegion()).findByTestId('dashboard-first-level')
    expect(screen.queryByTestId('ops-incident-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ops-why-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ops-action-panel')).not.toBeInTheDocument()
    expect(screen.queryByText('Operations Center')).not.toBeInTheDocument()
  })
})
