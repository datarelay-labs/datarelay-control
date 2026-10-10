import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Log and Continue')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Failed output (1m)')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Retry rate (5m)')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Receiver-confirmed ingestion')
    expect(screen.getByTestId('routes-architecture-inspector')).toHaveTextContent('Not verified by this snapshot')
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
})
