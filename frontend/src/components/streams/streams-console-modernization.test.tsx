import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamsConsole } from './streams-console'
import { clearStreamsConsoleSnapshot } from './streams-console-cache'

vi.mock('../../api/gdcStreams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcStreams')>()
  return {
    ...actual,
    fetchStreamsListResult: vi.fn(),
  }
})

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: vi.fn(async () => null),
  fetchStreamRuntimeStatsHealth: vi.fn(async () => null),
  runStreamOnce: vi.fn(),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => [
    { id: 10, name: 'office365-connector', product_group: 'Office365' },
    { id: 11, name: 'aws-connector', product_group: 'Amazon Web Services' },
  ]),
  fetchConnectorById: vi.fn(async (id: number) => ({
    id,
    name: id === 10 ? 'office365-connector' : 'aws-connector',
    product_group: id === 10 ? 'Office365' : 'Amazon Web Services',
  })),
}))

vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: vi.fn(async () => []),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(async () => ({
    global: {
      health_status: 'DEGRADED',
      total_streams: 2,
      enabled_streams: 2,
      running_streams: 1,
      error_streams: 1,
      total_routes: 0,
      enabled_routes: 0,
      total_destinations: 0,
      enabled_destinations: 0,
      total_eps_1m: 5,
      total_eps_5m: 5,
      avg_latency_ms: 10,
      last_activity_at: null,
    },
    streams: [
      {
        stream_id: 1,
        stream_name: 'login-stream',
        connector_id: 10,
        source_id: 1,
        enabled: true,
        status: 'RUNNING',
        health_status: 'HEALTHY',
        eps_1m: 3,
        eps_5m: 3,
        success_rate_5m: 99,
        failure_rate_5m: 1,
        avg_latency_ms: 10,
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
        stream_id: 2,
        stream_name: 'audit-stream',
        connector_id: 10,
        source_id: 2,
        enabled: true,
        status: 'ERROR',
        health_status: 'ERROR',
        eps_1m: 2,
        eps_5m: 2,
        success_rate_5m: 40,
        failure_rate_5m: 60,
        avg_latency_ms: 40,
        route_count: 0,
        healthy_route_count: 0,
        failed_route_count: 0,
        last_success_at: null,
        last_error_at: '2026-01-01T00:00:00Z',
        last_error_message: 'Destination Error',
        checkpoint_updated_at: null,
        checkpoint_lag_seconds: null,
      },
    ],
    routes: [],
    destinations: [],
    problems: [
      {
        severity: 'critical',
        scope: 'stream',
        stream_id: 2,
        route_id: null,
        destination_id: null,
        title: 'Delivery error',
        message: 'Destination Error',
        last_seen_at: null,
      },
    ],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))

import { fetchStreamsListResult } from '../../api/gdcStreams'

describe('StreamsConsole SaaS modernization', () => {
  afterEach(() => {
    vi.clearAllMocks()
    clearStreamsConsoleSnapshot()
  })

  beforeEach(() => {
    vi.mocked(fetchStreamsListResult).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          id: 1,
          name: 'login-stream',
          connector_id: 10,
          stream_type: 'HTTP_API_POLLING',
          status: 'RUNNING',
        },
        {
          id: 2,
          name: 'audit-stream',
          connector_id: 10,
          stream_type: 'HTTP_API_POLLING',
          status: 'ERROR',
        },
      ],
    })
  })

  it('renders group-first hierarchy without duplicate page heading or NOC KPI wall', async () => {
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('streams-health-overview')).toBeInTheDocument()
    expect(screen.getByTestId('streams-health-posture')).toHaveTextContent('Critical')
    expect(screen.getByRole('columnheader', { name: 'Stream group' })).toBeInTheDocument()
    expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Streams$/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('streams-group-kpi-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('overall-health-beacon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('health-summary-strip')).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'EPS (5m Avg)' })).not.toBeInTheDocument()
  })

  it('expands a group to reveal affected streams for problem identification', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    expect(screen.queryByTestId('stream-group-child-row-2')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId('stream-group-row-Office365'))
    expect(await screen.findByTestId('stream-group-child-row-1')).toBeInTheDocument()
    expect(screen.getByTestId('stream-group-child-row-2')).toBeInTheDocument()
    expect(screen.getByTestId('stream-row-issues-2')).toHaveTextContent('Destination Error')
  })

  it('keeps search and quick filters functional', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    await screen.findByTestId('streams-search-input')
    await user.type(screen.getByTestId('streams-search-input'), 'audit-stream')
    await waitFor(() => {
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
    })

    await user.clear(screen.getByTestId('streams-search-input'))
    await user.click(screen.getByTestId('streams-quick-filter-critical'))
    await waitFor(() => {
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
    })
  })

  it('uses operator empty-state copy without validation-lab instructions', async () => {
    vi.mocked(fetchStreamsListResult).mockResolvedValue({
      ok: true,
      status: 200,
      data: [],
    })

    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    const empty = await screen.findByTestId('streams-empty-state')
    expect(empty).toHaveTextContent(/No streams are configured yet/i)
    expect(empty).not.toHaveTextContent(/ENABLE_DEV_VALIDATION_LAB/)
    expect(empty).not.toHaveTextContent(/scripts\/seed\.py/)
    expect(empty).not.toHaveTextContent(/dev-validation-lab/)
    expect(screen.getByTestId('streams-create-first')).toBeInTheDocument()
  })
})
