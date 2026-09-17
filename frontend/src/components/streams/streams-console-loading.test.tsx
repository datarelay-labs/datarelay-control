import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { StreamsConsole } from './streams-console'
import { GDC_AUTH_REQUIRED_MESSAGE } from '../../api/gdcStreams'

vi.mock('../../api/gdcStreams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcStreams')>()
  return {
    ...actual,
    fetchStreamsListResult: vi.fn(),
    fetchStreamById: vi.fn(async () => null),
  }
})

vi.mock('../../api/gdcRuntime', () => ({
  fetchRuntimeDashboardSummary: vi.fn(async () => null),
  fetchStreamMappingUiConfig: vi.fn(async () => null),
  fetchBulkStreamStatsHealth: vi.fn(async () => null),
  fetchStreamRuntimeStatsHealth: vi.fn(async () => null),
  fetchStreamRuntimeTimeline: vi.fn(async () => null),
  fetchStreamRuntimeStats: vi.fn(async () => null),
  fetchStreamRuntimeMetrics: vi.fn(async () => null),
  fetchRuntimeLogsPage: vi.fn(async () => null),
  searchRuntimeDeliveryLogs: vi.fn(async () => null),
  startRuntimeStream: vi.fn(),
  stopRuntimeStream: vi.fn(),
  runStreamOnce: vi.fn(),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => [
    { id: 1, name: 'db-connector', product_group: 'Database Query' },
    { id: 2, name: 's3-connector', product_group: 'Amazon S3' },
    { id: 3, name: 'sftp-connector', product_group: 'Remote File' },
  ]),
  fetchConnectorById: vi.fn(async (id: number) => ({
    id,
    name: id === 1 ? 'db-connector' : id === 2 ? 's3-connector' : 'sftp-connector',
    product_group: id === 1 ? 'Database Query' : id === 2 ? 'Amazon S3' : 'Remote File',
  })),
}))
vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(async () => ({
    global: { health_status: 'HEALTHY', total_streams: 0, running_streams: 0, total_eps_1m: 0 },
    streams: [],
    routes: [],
    destinations: [],
    problems: [],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))
vi.mock('../../api/gdcDestinations', () => ({ fetchDestinationsList: vi.fn(async () => []) }))
vi.mock('../../api/gdcRoutes', () => ({ fetchRoutesList: vi.fn(async () => []) }))

import { fetchStreamsListResult } from '../../api/gdcStreams'
import { clearStreamsConsoleSnapshot } from './streams-console-cache'

describe('StreamsConsole loading states', () => {
  afterEach(() => {
    vi.clearAllMocks()
    clearStreamsConsoleSnapshot()
  })

  it('stops loading and shows auth message on 401', async () => {
    vi.mocked(fetchStreamsListResult).mockResolvedValue({
      ok: false,
      status: 401,
      message: GDC_AUTH_REQUIRED_MESSAGE,
      authRequired: true,
    })

    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.queryByText(/Loading streams/i)).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('streams-auth-required')).toHaveTextContent(GDC_AUTH_REQUIRED_MESSAGE)
  })

  it('renders empty state for successful empty list', async () => {
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

    await waitFor(() => {
      expect(screen.queryByText(/Loading streams/i)).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('streams-empty-state')).toBeInTheDocument()
  })

  it('renders dev-validation non-HTTP source types from Streams API rows', async () => {
    vi.mocked(fetchStreamsListResult).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          id: 101,
          name: '[DEV VALIDATION] Database Query PostgreSQL E2E',
          connector_id: 1,
          source_id: 11,
          enabled: true,
          stream_type: 'DATABASE_QUERY',
          source_type: 'DATABASE_QUERY',
          status: 'RUNNING',
        },
        {
          id: 102,
          name: '[DEV VALIDATION] S3 Object Polling E2E',
          connector_id: 2,
          source_id: 12,
          enabled: true,
          stream_type: 'S3_OBJECT_POLLING',
          source_type: 'S3_OBJECT_POLLING',
          status: 'RUNNING',
        },
        {
          id: 103,
          name: '[DEV VALIDATION] Remote File SFTP E2E',
          connector_id: 3,
          source_id: 13,
          enabled: true,
          stream_type: 'REMOTE_FILE_POLLING',
          source_type: 'REMOTE_FILE_POLLING',
          status: 'RUNNING',
        },
      ],
    })

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    // Product-group console hides child stream names until a group is expanded
    // (legacy flat-table visibility was removed).
    await user.click(await screen.findByTestId('stream-group-row-Database Query'))
    expect(await screen.findByTestId('stream-group-child-row-101')).toBeInTheDocument()
    expect(screen.getByText('[DEV VALIDATION] Database Query PostgreSQL E2E')).toBeInTheDocument()

    await user.click(await screen.findByTestId('stream-group-row-Amazon S3'))
    expect(await screen.findByTestId('stream-group-child-row-102')).toBeInTheDocument()
    expect(screen.getByText('[DEV VALIDATION] S3 Object Polling E2E')).toBeInTheDocument()

    await user.click(await screen.findByTestId('stream-group-row-Remote File'))
    expect(await screen.findByTestId('stream-group-child-row-103')).toBeInTheDocument()
    expect(screen.getByText('[DEV VALIDATION] Remote File SFTP E2E')).toBeInTheDocument()
  })

  it('restores cached rows on remount without showing the full-screen loader', async () => {
    vi.mocked(fetchStreamsListResult).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          id: 201,
          name: 'Cached Stream Alpha',
          connector_id: 1,
          source_id: 21,
          stream_type: 'HTTP_POLLING',
          source_type: 'HTTP_POLLING',
          status: 'RUNNING',
        },
      ],
    })

    const { unmount } = render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.queryByText(/Loading streams/i)).not.toBeInTheDocument()
    })
    expect(screen.getByText('1 Stream Group | 1 Stream')).toBeInTheDocument()

    unmount()

    vi.mocked(fetchStreamsListResult).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                data: [
                  {
                    id: 201,
                    name: 'Cached Stream Alpha',
                    connector_id: 1,
                    source_id: 21,
                    stream_type: 'HTTP_POLLING',
                    source_type: 'HTTP_POLLING',
                    status: 'RUNNING',
                  },
                ],
              }),
            5000,
          )
        }),
    )

    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    expect(screen.queryByText(/Loading streams/i)).not.toBeInTheDocument()
    expect(screen.getByText('1 Stream Group | 1 Stream')).toBeInTheDocument()
  })
})
