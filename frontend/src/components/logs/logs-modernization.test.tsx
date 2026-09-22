import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcRuntime from '../../api/gdcRuntime'
import { LogDetailDrawer } from './log-detail-drawer'
import { LogsDiagnosisOverview, type LogsDiagnosisSnapshot } from './logs-diagnosis-overview'
import { LogsExplorerPage } from './logs-explorer-page'
import type { LogExplorerRow } from './logs-types'

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
      delivery_success_events: 2,
      delivery_failed_events: 1,
      retry_success_events: 0,
      retry_failed_events: 0,
      runtime_telemetry_rows: 3,
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

function baseRow(overrides: Partial<LogExplorerRow> = {}): LogExplorerRow {
  return {
    id: 'log-1',
    eventId: 'evt_1',
    timeIso: '2026-01-01T00:00:00.000Z',
    level: 'ERROR',
    connector: 'Conn A',
    stream: 'Stream A',
    route: 'Route A',
    message: 'Delivery failed to destination',
    durationMs: 12,
    relatedEventId: null,
    contextJson: {
      stage: 'route_send_failed',
      status: 'FAILED',
      log_db_id: 42,
      stream_id: 7,
      route_id: 3,
      destination_id: 9,
      error_code: 'HTTP_502',
      retry_count: 2,
    },
    ...overrides,
  }
}

describe('LogsDiagnosisOverview', () => {
  it('renders calm diagnosis posture from existing sample evidence', () => {
    const snapshot: LogsDiagnosisSnapshot = {
      loadedFailedDeliveries: 2,
      loadedSuccessfulDeliveries: 5,
      errorRows: 2,
      warningRows: 1,
      loadedRows: 8,
      globalFailed: 4,
      globalSuccess: 10,
      lifecycleRows: 1,
      windowLabel: '1h',
    }
    render(<LogsDiagnosisOverview snapshot={snapshot} />)
    expect(screen.getByTestId('logs-diagnosis-overview')).toBeInTheDocument()
    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent(/Needs recovery/i)
    expect(screen.getByTestId('logs-overview-failed')).toHaveTextContent('2')
    expect(screen.getByTestId('logs-overview-success')).toHaveTextContent('5')
  })
})

describe('LogsExplorerPage modernization', () => {
  beforeEach(() => {
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsPage').mockResolvedValue(emptyPage as never)
    vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue(emptySearch as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeLogsTotals').mockResolvedValue(emptyTotals as never)
    vi.spyOn(gdcRuntime, 'fetchRuntimeDashboardSummary').mockResolvedValue(null)
  })

  it('shows SaaS hierarchy: purpose, diagnosis overview, search, and presets', async () => {
    render(
      <MemoryRouter initialEntries={['/logs']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('logs-explorer-page')).toBeInTheDocument()
    expect(screen.getByText(/What failed, and how do I recover/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Logs$/i })).not.toBeInTheDocument()
    expect(await screen.findByTestId('logs-diagnosis-overview')).toBeInTheDocument()
    expect(screen.getByTestId('logs-search')).toBeInTheDocument()
    expect(screen.getByTestId('logs-filter-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('logs-presets')).toBeInTheDocument()
  })

  it('presents no-match empty state for active URL filters', async () => {
    render(
      <MemoryRouter initialEntries={['/logs?status=failed']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('logs-no-match')).toBeInTheDocument()
    expect(screen.getByText(/No logs match the active filters/i)).toBeInTheDocument()
  })

  it('expands secondary presets without inventing recovery actions', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/logs']}>
        <LogsExplorerPage />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/Schema Drift Policy/i)).not.toBeInTheDocument()
    await user.click(screen.getByTestId('logs-presets-more'))
    expect(screen.getByText(/Schema Drift Policy/i)).toBeInTheDocument()
  })
})

describe('LogDetailDrawer modernization', () => {
  it('shows diagnosis summary, Runtime primary, and replay only when eligible', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <LogDetailDrawer row={baseRow()} onClose={() => undefined} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('log-detail-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('log-detail-diagnosis')).toHaveTextContent(/ERROR/i)
    expect(screen.getByTestId('log-detail-diagnosis')).toHaveTextContent(/HTTP_502/)
    expect(screen.getByTestId('log-detail-open-runtime')).toBeInTheDocument()
    expect(screen.getByTestId('log-detail-stream-runtime')).toBeInTheDocument()
    expect(screen.getByTestId('log-detail-stream-edit')).toHaveTextContent(/^Edit$/)
    expect(screen.getByTestId('log-detail-replay-panel')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-log-dry-run-replay')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-log-live-replay-open')).toBeInTheDocument()
    await user.click(screen.getByTestId('log-detail-tab-trace'))
    expect(screen.getByTestId('log-detail-tab-trace')).toHaveAttribute('aria-selected', 'true')
  })

  it('hides replay actions when row is not eligible', () => {
    render(
      <MemoryRouter>
        <LogDetailDrawer
          row={baseRow({
            level: 'INFO',
            contextJson: {
              stage: 'run_complete',
              status: 'OK',
              log_db_id: 42,
              stream_id: 7,
            },
          })}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('log-detail-diagnosis')).toBeInTheDocument()
    expect(screen.queryByTestId('log-detail-replay-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delivery-log-live-replay-open')).not.toBeInTheDocument()
  })
})
