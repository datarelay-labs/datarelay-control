import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as gdcRuntime from '../../api/gdcRuntime'
import { LogsExplorerPage } from './logs-explorer-page'

const SNAPSHOT_ID = '2026-06-05T10:00:00Z'

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => [
    { id: 1, name: 'Repeated stream' },
    { id: 2, name: 'Repeated stream' },
  ]),
}))
vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: vi.fn(async () => [
    { id: 41, name: 'Repeated route' },
    { id: 42, name: 'Repeated route' },
  ]),
}))
vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [{ id: 10, name: 'Receiving destination' }]),
}))
vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => []),
}))
vi.mock('../../api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(async (_window: string, params?: { snapshot_id?: string }) => ({
    snapshot_id: params?.snapshot_id ?? SNAPSHOT_ID,
    generated_at: params?.snapshot_id ?? SNAPSHOT_ID,
    window: '1h',
    window_start: '2026-06-05T09:00:00Z',
    window_end: SNAPSHOT_ID,
    metric_contract_version: 'v1',
    totals: {
      streams_total: 2,
      streams_running: 2,
      routes_total: 2,
      routes_enabled: 2,
      healthy_routes: 1,
      idle_routes: 0,
      unhealthy_routes: 1,
      delivery_success_events: 1,
      delivery_failed_events: 1,
      retry_success_events: 0,
      retry_failed_events: 0,
      runtime_telemetry_rows: 2,
      lifecycle_rows: 0,
      processed_events: 0,
      throughput_eps: 0,
      p95_latency_ms: null,
    },
    metric_contract: {},
    metric_meta: {},
  })),
}))

function row(id: number, stream: number, route: number, message: string) {
  return {
    id,
    created_at: SNAPSHOT_ID,
    level: 'ERROR',
    stage: 'webhook_send',
    status: 'FAILED',
    message,
    stream_id: stream,
    route_id: route,
    destination_id: 10,
    connector_id: null,
    run_id: null,
    latency_ms: 0,
    retry_count: 0,
    error_code: 'DELIVERY_FAILED',
    payload_sample: null,
  }
}

function setup(items: ReturnType<typeof row>[]) {
  const fetchPage = vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockImplementation(async (params) => ({
    total_returned: items.length,
    has_next: false,
    next_cursor_created_at: null,
    next_cursor_id: null,
    items,
    snapshot_id: params.snapshot_id,
    metric_meta: {},
  } as never))
  vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockImplementation(async (params) => ({
    total_returned: 0,
    filters: {},
    logs: [],
    snapshot_id: params.snapshot_id,
    metric_meta: {},
  } as never))
  vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockImplementation(async (params) => ({
    metrics_window_seconds: 3600,
    window_start: '2026-06-05T09:00:00Z',
    window_end: SNAPSHOT_ID,
    total_rows: items.length,
    error_rows: items.length,
    warning_rows: 0,
    info_rows: 0,
    debug_rows: 0,
    snapshot_id: params.snapshot_id,
    metric_meta: {},
  } as never))
  vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)
  return { fetchPage }
}

afterEach(() => vi.restoreAllMocks())

describe('Logs Explorer receiving an actual Data Flows numeric-ID drilldown', () => {
  it('retains Route 42 + Stream 2 + Destination 10 evidence even when Stream names are duplicated', async () => {
    const { fetchPage } = setup([row(72, 2, 42, 'Actual Route 42 failed delivery')])
    render(
      <MemoryRouter initialEntries={['/logs?route_id=42&stream_id=2&destination_id=10']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      route_id: 42, stream_id: 2, destination_id: 10,
    })))
    await waitFor(() =>
      expect(screen.getByLabelText('Stream')).toHaveValue('Repeated stream (Stream #2)'),
    )
    const activeFilters = screen.getByRole('region', { name: 'Active URL filters' })
    expect(activeFilters).toHaveTextContent('Stream · Repeated stream (Stream #2)')
    expect(activeFilters).toHaveTextContent('Route · Repeated route (Route #42)')
    expect(await screen.findByText('Actual Route 42 failed delivery')).toBeInTheDocument()
  })

  it('makes duplicate Stream and Route choices independently selectable by stable numeric identity', async () => {
    const user = userEvent.setup()
    setup([
      row(71, 1, 41, 'First stream Route 41 evidence'),
      row(72, 2, 42, 'Second stream Route 42 evidence'),
    ])
    render(<MemoryRouter initialEntries={['/logs']}><LogsExplorerPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('option', { name: 'Repeated stream (Stream #2)' })).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText('Stream'), 'Repeated stream (Stream #2)')
    expect(screen.getByText('Second stream Route 42 evidence')).toBeInTheDocument()
    expect(screen.queryByText('First stream Route 41 evidence')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Stream'), 'All Streams')
    await user.selectOptions(screen.getByLabelText('Route'), 'Repeated route (Route #42)')
    expect(screen.getByText('Second stream Route 42 evidence')).toBeInTheDocument()
    expect(screen.queryByText('First stream Route 41 evidence')).not.toBeInTheDocument()
  })

  it('switching Stream from a Data Flows deep link updates actual API scope and clears stale Route/Destination IDs', async () => {
    const user = userEvent.setup()
    const { fetchPage } = setup([
      row(71, 1, 41, 'First stream Route 41 evidence'),
      row(72, 2, 42, 'Second stream Route 42 evidence'),
    ])
    render(
      <MemoryRouter initialEntries={['/logs?route_id=42&stream_id=2&destination_id=10']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByLabelText('Stream')).toHaveValue('Repeated stream (Stream #2)'))
    await user.selectOptions(screen.getByLabelText('Stream'), 'Repeated stream (Stream #1)')
    await waitFor(() => {
      expect(fetchPage.mock.calls.at(-1)?.[0]).toMatchObject({ stream_id: 1 })
      expect(fetchPage.mock.calls.at(-1)?.[0]?.route_id).toBeUndefined()
      expect(fetchPage.mock.calls.at(-1)?.[0]?.destination_id).toBeUndefined()
    })
    expect(await screen.findByText('First stream Route 41 evidence')).toBeInTheDocument()
    expect(screen.queryByText('Second stream Route 42 evidence')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove route filter' })).not.toBeInTheDocument()
  })

  it('switching Route from a Data Flows deep link updates actual API scope without the previous Stream/Destination filter', async () => {
    const user = userEvent.setup()
    const { fetchPage } = setup([
      row(71, 1, 41, 'First stream Route 41 evidence'),
      row(72, 2, 42, 'Second stream Route 42 evidence'),
    ])
    render(
      <MemoryRouter initialEntries={['/logs?route_id=42&stream_id=2&destination_id=10']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByLabelText('Route')).toHaveValue('Repeated route (Route #42)'))
    await user.selectOptions(screen.getByLabelText('Route'), 'Repeated route (Route #41)')
    await waitFor(() => {
      expect(fetchPage.mock.calls.at(-1)?.[0]).toMatchObject({ route_id: 41 })
      expect(fetchPage.mock.calls.at(-1)?.[0]?.stream_id).toBeUndefined()
      expect(fetchPage.mock.calls.at(-1)?.[0]?.destination_id).toBeUndefined()
    })
    expect(await screen.findByText('First stream Route 41 evidence')).toBeInTheDocument()
    expect(screen.queryByText('Second stream Route 42 evidence')).not.toBeInTheDocument()
  })

  it('removing the numeric Route URL chip also removes any residual hidden route dropdown filter', async () => {
    const user = userEvent.setup()
    setup([row(72, 2, 42, 'Route 42 retained after chip removal')])
    render(<MemoryRouter initialEntries={['/logs?route_id=42']}><LogsExplorerPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Route')).toHaveValue('Repeated route (Route #42)'))
    await user.click(screen.getByRole('button', { name: 'Remove route filter' }))
    expect(screen.getByLabelText('Route')).toHaveValue('All Routes')
    expect(screen.getByText('Route 42 retained after chip removal')).toBeInTheDocument()
  })

  it('removing a numeric Stream URL chip does not leave a hidden name filter', async () => {
    const user = userEvent.setup()
    setup([row(72, 2, 42, 'Recovered scope still shows Route 42')])
    render(<MemoryRouter initialEntries={['/logs?stream_id=2']}><LogsExplorerPage /></MemoryRouter>)
    expect(await screen.findByText('Recovered scope still shows Route 42')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove stream filter' }))
    expect(screen.queryByRole('button', { name: 'Remove stream filter' })).not.toBeInTheDocument()
    expect(screen.getByText('Recovered scope still shows Route 42')).toBeInTheDocument()
  })
})
