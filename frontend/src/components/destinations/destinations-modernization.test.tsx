import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DestinationsManagementPage } from './destinations-management-page'
import { DestinationDetailPage } from './destination-detail-page'
import { DestinationsHealthOverview } from './destinations-health-overview'
import { computeDestinationsKpi, type DestinationsKpi } from './destination-kpi-strip'
import type { DestinationOverviewRow } from './use-destinations-overview-data'

const healthyRow = (overrides: Partial<DestinationOverviewRow> = {}): DestinationOverviewRow =>
  ({
    id: 9,
    name: 'MDS',
    destination_type: 'SYSLOG_UDP',
    config_json: { host: '10.0.0.1', port: 514 },
    rate_limit_json: {},
    enabled: true,
    streams_using_count: 1,
    routes: [{ route_id: 1, stream_id: 1, stream_name: 'Stream A', route_enabled: true, route_status: 'ENABLED' }],
    created_at: null,
    updated_at: null,
    runtime: {
      connectedStreams: 1,
      connectedRoutes: 1,
      successRatePct: 99,
      currentEps: 1.2,
      hasDeliveryActivity: true,
      health: 'Healthy',
      recentIssues: [],
      metricsWindowLabel: '1h',
    },
    ...overrides,
  }) as DestinationOverviewRow

vi.mock('./use-destinations-overview-data', () => ({
  useDestinationsOverviewData: vi.fn(() => ({
    rows: [healthyRow()],
    loading: false,
    runtimeLoading: false,
    error: null,
    runtimeError: null,
    refresh: vi.fn(),
  })),
}))

vi.mock('../../api/gdcDestinations', () => ({
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  deleteDestination: vi.fn(),
  previewTestDestination: vi.fn(),
  testDestination: vi.fn(async () => ({
    success: true,
    latency_ms: 3,
    message: 'ok',
    tested_at: '2026-05-09T12:00:00Z',
    detail: null,
  })),
  fetchDestinationById: vi.fn(),
  isDestinationStaleWriteError: () => false,
  DESTINATION_STALE_WRITE_CODE: 'DESTINATION_STALE_WRITE',
}))

vi.mock('./use-destination-detail-data', () => ({
  useDestinationDetailData: vi.fn(),
}))

describe('DestinationsHealthOverview', () => {
  it('renders calm posture without inventing capacity warnings', () => {
    const kpi: DestinationsKpi = {
      ...computeDestinationsKpi([healthyRow()]),
      capacityWarnings: 0,
      totalAlerts: 0,
    }
    render(<DestinationsHealthOverview kpi={kpi} />)
    expect(screen.getByTestId('destinations-health-overview')).toBeInTheDocument()
    expect(screen.getByTestId('destinations-health-posture')).toHaveTextContent('Healthy')
    expect(screen.getByTestId('destinations-capacity-summary')).toHaveTextContent(/No capacity limits/i)
  })

  it('reports capacity posture only from configured capacity evidence', () => {
    const row = healthyRow({
      rate_limit_json: {
        capacity_limit_eps: 10,
        capacity_warning_threshold_pct: 70,
        capacity_critical_threshold_pct: 85,
      },
      runtime: {
        ...healthyRow().runtime,
        currentEps: 8,
        health: 'Healthy',
      },
    })
    const kpi = computeDestinationsKpi([row])
    expect(kpi.capacityWarnings).toBe(1)
    render(<DestinationsHealthOverview kpi={kpi} />)
    expect(screen.getByTestId('destinations-health-posture')).toHaveTextContent('Warning')
    expect(screen.getByText(/near configured capacity/i)).toBeInTheDocument()
  })
})

describe('DestinationsManagementPage modernization', () => {
  it('shows SaaS hierarchy: purpose, primary action, and calm health overview', async () => {
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('destinations-management-page')).toBeInTheDocument()
    expect(screen.getByText(/Which destination needs attention/i)).toBeInTheDocument()
    expect(screen.getByTestId('destinations-new')).toBeInTheDocument()
    expect(await screen.findByTestId('destinations-health-overview')).toBeInTheDocument()
    expect(screen.getByTestId('destinations-search')).toBeInTheDocument()
    expect(screen.getByTestId('destinations-status-filter')).toBeInTheDocument()
  })

  it('filters destinations by search without losing the row structure', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('destination-row-9')).toBeInTheDocument()
    await user.type(screen.getByTestId('destinations-search'), 'zzz-no-match')
    expect(await screen.findByTestId('destinations-no-match')).toBeInTheDocument()
  })
})

describe('DestinationDetailPage capacity truth', () => {
  beforeEach(async () => {
    const { useDestinationDetailData } = await import('./use-destination-detail-data')
    vi.mocked(useDestinationDetailData).mockReturnValue({
      destination: {
        id: 9,
        name: 'MDS',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.1', port: 514 },
        rate_limit_json: {
          capacity_limit_eps: 100,
          capacity_warning_threshold_pct: 70,
          capacity_critical_threshold_pct: 85,
        },
        enabled: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      listRow: null,
      uiHealth: 'Healthy',
      healthState: 'HEALTHY',
      connectedStreams: [],
      connectedRoutes: [],
      successRatePct: 99,
      currentEps: 40,
      failed24h: 0,
      avgLatencyMs: 12,
      lastDeliveryAt: null,
      lastErrorMessage: null,
      recentActivity: [],
      recentFailures: [],
      healthRow: null,
      failuresAnalytics: null,
      loading: false,
      runtimeLoading: false,
      error: null,
      refresh: vi.fn(),
      runConnectivityTest: vi.fn(async () => ({ success: true, message: 'ok' })),
      testBusy: false,
    } as ReturnType<typeof useDestinationDetailData>)
  })

  it('exposes configured Maximum EPS and usage on Overview', async () => {
    render(
      <MemoryRouter initialEntries={['/destinations/9']}>
        <Routes>
          <Route path="/destinations/:destinationId" element={<DestinationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('destination-capacity-maximum')).toHaveTextContent('100')
    expect(screen.getByTestId('destination-capacity-usage')).toHaveTextContent('40%')
    expect(screen.getAllByText('Maximum EPS').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/capacity warning/i)).not.toBeInTheDocument()
  })

  it('shows No limit when capacity is not configured', async () => {
    const { useDestinationDetailData } = await import('./use-destination-detail-data')
    vi.mocked(useDestinationDetailData).mockReturnValue({
      ...vi.mocked(useDestinationDetailData)(),
      destination: {
        id: 9,
        name: 'MDS',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.1', port: 514 },
        rate_limit_json: {},
        enabled: true,
        created_at: null,
        updated_at: null,
      },
      currentEps: 1,
    } as ReturnType<typeof useDestinationDetailData>)

    render(
      <MemoryRouter initialEntries={['/destinations/9']}>
        <Routes>
          <Route path="/destinations/:destinationId" element={<DestinationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('destination-capacity-maximum')).toHaveTextContent('No limit')
    expect(screen.getByTestId('destination-capacity-usage')).toHaveTextContent('—')
  })
})
