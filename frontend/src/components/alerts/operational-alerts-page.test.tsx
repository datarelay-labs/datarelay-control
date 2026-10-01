import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalAlertsPage } from './operational-alerts-page'

const getOperationalSnapshotMock = vi.fn()
const fetchRuntimeAlertSummaryMock = vi.fn()
const fetchRuntimeDashboardSummaryMock = vi.fn()
const fetchValidationAlertsMock = vi.fn()
const fetchDestinationsListMock = vi.fn()

vi.mock('../../api/operationalSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/operationalSnapshot')>()
  return {
    ...actual,
    getOperationalSnapshot: () => getOperationalSnapshotMock(),
    clearOperationalSnapshotCache: vi.fn(),
  }
})
vi.mock('../../api/gdcRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcRuntime')>()
  return {
    ...actual,
    fetchRuntimeAlertSummary: () => fetchRuntimeAlertSummaryMock(),
    fetchRuntimeDashboardSummary: () => fetchRuntimeDashboardSummaryMock(),
    invalidateDashboardAnalyticsCache: vi.fn(),
  }
})

vi.mock('../../api/gdcValidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcValidation')>()
  return {
    ...actual,
    fetchValidationAlerts: () => fetchValidationAlertsMock(),
  }
})
vi.mock('../../api/gdcDestinations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcDestinations')>()
  return {
    ...actual,
    fetchDestinationsList: () => fetchDestinationsListMock(),
  }
})

function renderPage() {
  return render(
    <MemoryRouter>
      <OperationalAlertsPage />
    </MemoryRouter>,
  )
}

describe('OperationalAlertsPage', () => {
  beforeEach(() => {
    getOperationalSnapshotMock.mockReset()
    fetchRuntimeAlertSummaryMock.mockReset()
    fetchRuntimeDashboardSummaryMock.mockReset()
    fetchValidationAlertsMock.mockReset()
    fetchDestinationsListMock.mockReset()
  })
  it('composes runtime, capacity, schema drift and validation facts without inventing a new alert source', async () => {
    getOperationalSnapshotMock.mockResolvedValue({
      global: {
        health_status: 'DEGRADED',
        total_streams: 1,
        enabled_streams: 1,
        running_streams: 1,
        error_streams: 0,
        total_routes: 1,
        enabled_routes: 1,
        total_destinations: 1,
        enabled_destinations: 1,
        total_eps_1m: 80,
        total_eps_5m: 75,
        avg_latency_ms: 10,
        last_activity_at: '2026-10-01T12:00:00Z',
      },
      streams: [{
        stream_id: 7,
        stream_name: 'Office365 Audit',
        connector_id: 1,
        source_id: 1,
        enabled: true,
        status: 'RUNNING',
        health_status: 'DEGRADED',
        eps_1m: 80,
        eps_5m: 75,
        success_rate_5m: 98,
        failure_rate_5m: 2,
        avg_latency_ms: 10,
        route_count: 1,
        healthy_route_count: 0,
        failed_route_count: 1,
        last_success_at: '2026-10-01T12:00:00Z',
        last_error_at: '2026-10-01T12:01:00Z',
        last_error_message: 'delivery slowed',
        checkpoint_updated_at: '2026-10-01T12:00:00Z',
        checkpoint_lag_seconds: 20,
      }],
      routes: [],
      destinations: [{
        destination_id: 3,
        destination_name: 'Splunk',
        destination_type: 'SYSLOG_TCP',
        enabled: true,
        health_status: 'HEALTHY',
        inbound_eps_1m: 80,
        failed_eps_1m: 0,
        avg_latency_ms: 10,
        route_count: 1,
        last_success_at: '2026-10-01T12:00:00Z',
        last_error_at: null,
        last_error_message: null,
      }],
      problems: [{
        severity: 'warning',
        scope: 'stream',
        stream_id: 7,
        route_id: null,
        destination_id: null,
        title: 'Stream Office365 Audit has delivery failures',
        message: 'Failure rate (5m): 2.00%',
        last_seen_at: '2026-10-01T12:01:00Z',
      }],
      updated_at: '2026-10-01T12:02:00Z',
    })

    fetchRuntimeAlertSummaryMock.mockResolvedValue({
      metrics_window_seconds: 3600,
      items: [{
        stream_id: 7,
        stream_name: 'Office365 Audit',
        connector_name: 'Office365',
        severity: 'WARN',
        count: 3,
        latest_occurrence: '2026-10-01T12:01:00Z',
      }],
    })
    fetchRuntimeDashboardSummaryMock.mockResolvedValue({
      summary: {},
      recent_problem_routes: [],
      recent_rate_limited_routes: [],
      recent_unhealthy_streams: [],
      open_schema_field_drift_count: 2,
    })

    fetchValidationAlertsMock.mockResolvedValue([{
      id: 9,
      validation_id: 4,
      validation_run_id: null,
      severity: 'WARNING',
      alert_type: 'DESTINATION_FAILURE',
      status: 'OPEN',
      title: 'Destination check failed',
      message: 'Recent validation could not deliver',
      fingerprint: 'x',
      triggered_at: '2026-10-01T12:01:00Z',
      acknowledged_at: null,
      resolved_at: null,
      created_at: '2026-10-01T12:01:00Z',
    }])

    fetchDestinationsListMock.mockResolvedValue([{
      id: 3,
      name: 'Splunk',
      destination_type: 'SYSLOG_TCP',
      config_json: { host: '127.0.0.1', port: 514 },
      rate_limit_json: {
        capacity_limit_eps: 100,
        capacity_warning_threshold_pct: 70,
        capacity_critical_threshold_pct: 90,
      },
      enabled: true,
      created_at: null,
      updated_at: null,
      streams_using_count: 1,
      routes: [],
    }])

    renderPage()

    expect(await screen.findByText('Operational alerts')).toBeInTheDocument()
    expect(screen.getByText('Schema drift').parentElement).toHaveTextContent('2')
    expect(screen.getByText('Capacity warnings').parentElement).toHaveTextContent('1')
    expect(screen.getByRole('link', { name: /Splunk capacity at 80%/ })).toHaveAttribute('href', '/destinations/3')
    expect(screen.getByRole('link', { name: 'Office365 Audit' })).toHaveAttribute('href', '/streams/7/runtime')
    expect(screen.getByRole('link', { name: 'Destination check failed' })).toHaveAttribute(
      'href',
      '/validation/runs?validation_id=4',
    )
  })
  it('shows a truthful empty state when all sources are available and report no issues', async () => {
    getOperationalSnapshotMock.mockResolvedValue({
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
      updated_at: '2026-10-01T12:02:00Z',
    })
    fetchRuntimeAlertSummaryMock.mockResolvedValue({ metrics_window_seconds: 3600, items: [] })
    fetchRuntimeDashboardSummaryMock.mockResolvedValue({
      summary: {},
      recent_problem_routes: [],
      recent_rate_limited_routes: [],
      recent_unhealthy_streams: [],
      open_schema_field_drift_count: 0,
    })
    fetchValidationAlertsMock.mockResolvedValue([])
    fetchDestinationsListMock.mockResolvedValue([])

    renderPage()

    expect(await screen.findByTestId('operational-alerts-empty')).toHaveTextContent(
      'No current operational signals need attention.',
    )
    expect(screen.queryByTestId('operational-alerts-partial')).not.toBeInTheDocument()
  })
})
