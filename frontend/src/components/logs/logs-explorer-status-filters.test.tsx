import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as gdcRuntime from '../../api/gdcRuntime'
import { LogsExplorerPage } from './logs-explorer-page'

vi.mock('../../api/gdcStreams', () => ({ fetchStreamsList: vi.fn(async () => []) }))
vi.mock('../../api/gdcRoutes', () => ({ fetchRoutesList: vi.fn(async () => []) }))
vi.mock('../../api/gdcDestinations', () => ({ fetchDestinationsList: vi.fn(async () => []) }))
vi.mock('../../api/gdcConnectors', () => ({ fetchConnectorsList: vi.fn(async () => []) }))
vi.mock('../../api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(async (_window: string, params?: { snapshot_id?: string }) => ({
    snapshot_id: params?.snapshot_id ?? '2026-01-01T01:00:00Z',
    generated_at: params?.snapshot_id ?? '2026-01-01T01:00:00Z',
    window: '1h',
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-01T01:00:00Z',
    metric_contract_version: 'v1',
    totals: {
      streams_total: 0,
      streams_running: 0,
      routes_total: 0,
      routes_enabled: 0,
      healthy_routes: 0,
      idle_routes: 0,
      unhealthy_routes: 0,
      delivery_success_events: 0,
      delivery_failed_events: 0,
      retry_success_events: 0,
      retry_failed_events: 0,
      runtime_telemetry_rows: 0,
      lifecycle_rows: 0,
      processed_events: 0,
      throughput_eps: 0,
      p95_latency_ms: null,
    },
    metric_contract: {},
    metric_meta: {},
  })),
}))

const emptyPage = {
  total_returned: 0,
  has_next: false,
  next_cursor_created_at: null as string | null,
  next_cursor_id: null as number | null,
  items: [] as unknown[],
}

const emptySearch = {
  total_returned: 0,
  filters: {} as Record<string, unknown>,
  logs: [] as unknown[],
}

const emptyTotals = {
  metrics_window_seconds: 3600,
  window_start: '2026-01-01T00:00:00Z',
  window_end: '2026-01-01T01:00:00Z',
  total_rows: 0,
  error_rows: 0,
  warning_rows: 0,
  info_rows: 0,
  debug_rows: 0,
}

describe('LogsExplorerPage status URL → API', () => {
  it('passes FAILED to fetchRuntimeLogsPage when status=failed', async () => {
    const fetchPage = vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={['/logs?status=failed']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalled()
    })
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({
      status: 'FAILED',
    })
    fetchPage.mockRestore()
  })

  it('passes OK when status=success', async () => {
    const fetchPage = vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={['/logs?status=success']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalled()
    })
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({
      status: 'OK',
    })
    fetchPage.mockRestore()
  })

  it('passes route_retry_failed stage when status=retry', async () => {
    const fetchPage = vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={['/logs?status=retry']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalled()
    })
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({
      stage: 'route_retry_failed',
    })
    expect(fetchPage.mock.calls[0]?.[0]?.status).toBeUndefined()
    fetchPage.mockRestore()
  })

  it('shows delivery status dropdown matching URL on load', async () => {
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={['/logs?status=failed']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )

    const sel = await screen.findByLabelText(/Delivery status/i)
    expect(sel).toHaveValue('Failed')
  })
})


describe('Failed-attempt deep-link zero-results recovery', () => {
  it('clears only failed status, retaining saved Route/Stream/Destination identity', async () => {
    const user = userEvent.setup()
    const fetchPage = vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={['/logs?route_id=42&stream_id=2&destination_id=10&status=failed']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchPage.mock.calls.some(([request]) =>
        request?.route_id === 42 &&
        request?.stream_id === 2 &&
        request?.destination_id === 10 &&
        request?.status === 'FAILED',
      )).toBe(true)
    })
    const recovery = await screen.findByRole('button', { name: 'Show all statuses for this Route' })
    await user.click(recovery)
    await waitFor(() => {
      const latest = fetchPage.mock.calls.at(-1)?.[0]
      expect(latest).toMatchObject({ route_id: 42, stream_id: 2, destination_id: 10 })
      expect(latest?.status).toBeUndefined()
    })
    expect(screen.getByRole('button', { name: 'Remove route filter' })).toBeInTheDocument()
    fetchPage.mockRestore()
  })
})


describe('Route failure investigation has an explicit next step', () => {
  it('retains a read-only Data Flows return and exact saved Route settings link even with no matching failures', async () => {
    const fetchPage = vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={['/logs?route_id=42&stream_id=2&destination_id=10&status=failed']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      route_id: 42, stream_id: 2, destination_id: 10, status: 'FAILED',
    })))
    const next = screen.getByRole('region', { name: 'Route investigation next actions' })
    expect(next).toHaveTextContent('Investigating Route #42')
    expect(screen.getByRole('link', { name: 'Review Route #42 configuration' }))
      .toHaveAttribute('href', '/routes/42/edit')
    expect(screen.getByRole('link', { name: 'Back to Data Flows' }))
      .toHaveAttribute('href', '/routes')
    expect(await screen.findByRole('button', { name: 'Show all statuses for this Route' }))
      .toBeInTheDocument()
    fetchPage.mockRestore()
  })

  it('does not claim a return to nonexistent Route 0 from manually entered bad URL scope', async () => {
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)
    render(<MemoryRouter initialEntries={['/logs?route_id=0&status=failed']}><LogsExplorerPage /></MemoryRouter>)
    expect(await screen.findByText('Invalid Route ID ignored')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Route investigation next actions' }))
      .not.toBeInTheDocument()
  })
})
