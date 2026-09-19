import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StreamsConsole } from './streams-console'

vi.mock('../../api/gdcStreams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcStreams')>()
  return {
    ...actual,
    fetchStreamsListResult: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        name: `Stream ${i + 1}`,
        connector_id: 1,
        source_id: 1,
        enabled: true,
        stream_type: 'HTTP_API_POLLING',
        status: 'IDLE',
        polling_interval: 60,
      })),
    })),
    fetchStreamById: vi.fn(async () => null),
  }
})
vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => [{ id: 1, name: 'Connector 1', product_group: 'Connector 1' }]),
  fetchConnectorById: vi.fn(async () => ({ id: 1, name: 'Connector 1', product_group: 'Connector 1' })),
}))
vi.mock('../../api/gdcRuntime', () => ({
  fetchRuntimeDashboardSummary: vi.fn(async () => null),
  fetchStreamMappingUiConfig: vi.fn(async () => null),
  fetchBulkStreamStatsHealth: vi.fn(async () => null),
  fetchStreamRuntimeStatsHealth: vi.fn(async () => null),
  fetchStreamRuntimeTimeline: vi.fn(async () => null),
  fetchStreamRuntimeStats: vi.fn(async () => null),
  fetchStreamRuntimeMetrics: vi.fn(async () => null),
  fetchStreamById: vi.fn(async () => null),
  searchRuntimeDeliveryLogs: vi.fn(async () => null),
  fetchRuntimeLogsPage: vi.fn(async () => null),
  startRuntimeStream: vi.fn(async () => ({ message: 'ok' })),
  stopRuntimeStream: vi.fn(async () => ({ message: 'ok' })),
  runStreamOnce: vi.fn(async () => ({ message: 'ok' })),
}))
vi.mock('../../api/gdcRoutes', () => ({ fetchRoutesList: vi.fn(async () => []) }))
vi.mock('../../api/gdcDestinations', () => ({ fetchDestinationsList: vi.fn(async () => []) }))
vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(async () => ({
    global: {
      health_status: 'HEALTHY',
      total_streams: 60,
      enabled_streams: 60,
      running_streams: 0,
      error_streams: 0,
      total_eps_1m: 0,
    },
    streams: Array.from({ length: 60 }, (_, i) => ({
      stream_id: i + 1,
      stream_name: `Stream ${i + 1}`,
      connector_id: 1,
      source_id: 1,
      enabled: true,
      status: 'IDLE',
      health_status: 'HEALTHY',
      eps_1m: 0,
      eps_5m: 0,
      success_rate_5m: null,
      failure_rate_5m: null,
      avg_latency_ms: null,
      route_count: 0,
      healthy_route_count: 0,
      failed_route_count: 0,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    })),
    routes: [],
    destinations: [],
    problems: [],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))

describe('StreamsConsole large grouped rendering', () => {
  it(
    'renders large stream sets as product groups without legacy flat virtualization',
    async () => {
      const user = userEvent.setup()
      render(
        <MemoryRouter>
          <StreamsConsole />
        </MemoryRouter>,
      )

      expect(await screen.findByTestId('streams-product-groups')).toBeInTheDocument()
      expect(screen.queryByTestId('streams-console-virtual-scroll')).not.toBeInTheDocument()
      expect(screen.getByText(/1 Stream Group \| 60 Streams/i)).toBeInTheDocument()

      const groupRow = await screen.findByTestId('stream-group-row-Connector 1')
      await user.click(groupRow)

      expect(await screen.findByTestId('stream-group-child-row-1')).toBeInTheDocument()
      expect(screen.getByText('Stream 1')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-child-row-60')).toBeInTheDocument()
    },
    15000,
  )
})
