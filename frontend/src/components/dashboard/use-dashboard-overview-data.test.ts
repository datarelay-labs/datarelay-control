import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDashboardOverviewData } from './use-dashboard-overview-data'

vi.mock('../../api/gdcRuntime', () => ({
  fetchRuntimeDashboardSummary: vi.fn(async () => ({
    summary: { total_streams: 1, running_streams: 1 },
    runtime_engine_status: 'RUNNING',
  })),
  fetchRuntimeDashboardOutcomeTimeseries: vi.fn(async () => ({
    generated_at: '2026-01-01T00:00:00Z',
    metrics_window_seconds: 3600,
    buckets: [{ bucket_start: '2026-01-01T00:00:00Z', success: 1, failed: 0, rate_limited: 0 }],
  })),
  fetchRuntimeAlertSummary: vi.fn(async () => ({ metrics_window_seconds: 3600, items: [] })),
  invalidateDashboardAnalyticsCache: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => []),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => []),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(async () => ({
    global: {
      health_status: 'HEALTHY',
      total_streams: 2,
      enabled_streams: 2,
      running_streams: 2,
      error_streams: 0,
      total_routes: 1,
      enabled_routes: 1,
      total_destinations: 1,
      enabled_destinations: 1,
      total_eps_1m: 5,
      total_eps_5m: 5,
      avg_latency_ms: 10,
      last_activity_at: null,
    },
    streams: [
      {
        stream_id: 1,
        stream_name: 'S1',
        connector_id: 1,
        source_id: 1,
        enabled: true,
        status: 'RUNNING',
        health_status: 'HEALTHY',
        eps_1m: 5,
        eps_5m: 5,
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
    ],
    routes: [],
    destinations: [],
    problems: [],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))

describe('useDashboardOverviewData', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    const gdcRuntime = await import('../../api/gdcRuntime')
    vi.mocked(gdcRuntime.fetchRuntimeDashboardSummary).mockResolvedValue({
      summary: { total_streams: 1, running_streams: 1 },
      runtime_engine_status: 'RUNNING',
    })
    vi.mocked(gdcRuntime.fetchRuntimeAlertSummary).mockResolvedValue({ metrics_window_seconds: 3600, items: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads operational snapshot first and defers outcome timeseries', async () => {
    const gdcRuntime = await import('../../api/gdcRuntime')
    const { result } = renderHook(() => useDashboardOverviewData('1h', null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loadError).toBeNull()
    expect(result.current.bundle?.operationalSnapshot).not.toBeNull()
    expect(result.current.bundle?.operationalSnapshot?.global.running_streams).toBe(2)
    await waitFor(() => expect(result.current.bundle?.destinations).toEqual([]))
    expect(gdcRuntime.fetchRuntimeDashboardOutcomeTimeseries).toHaveBeenCalled()
    await waitFor(() => expect(result.current.bundle?.outcomeTs).not.toBeNull())
  })

  it('surfaces error when operational snapshot is unavailable', async () => {
    const operationalSnapshot = await import('../../api/operationalSnapshot')
    vi.mocked(operationalSnapshot.getOperationalSnapshot).mockResolvedValueOnce(null)
    const { result } = renderHook(() => useDashboardOverviewData('1h', null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loadError).toMatch(/operational snapshot/i)
    expect(result.current.bundle?.operationalSnapshot).toBeNull()
  })

  it('keeps snapshot KPI bundle when deferred APIs time out', async () => {
    const gdcRuntime = await import('../../api/gdcRuntime')
    vi.mocked(gdcRuntime.fetchRuntimeDashboardSummary).mockImplementationOnce(
      () =>
        new Promise(() => {
          /* never resolves — triggers 20s deadline */
        }),
    )

    const { result } = renderHook(() => useDashboardOverviewData('1h', null))

    await waitFor(() => {
      expect(result.current.bundle?.operationalSnapshot).not.toBeNull()
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.bundle?.operationalSnapshot?.global.running_streams).toBe(2)

    await waitFor(
      () => {
        expect(result.current.loadError).toMatch(/20s timeout/i)
        expect(result.current.bundle?.operationalSnapshot?.global.running_streams).toBe(2)
      },
      { timeout: 25_000 },
    )
  }, 35_000)

  it('merges partial deferred results without clearing snapshot when one API fails', async () => {
    const gdcRuntime = await import('../../api/gdcRuntime')
    vi.mocked(gdcRuntime.fetchRuntimeAlertSummary).mockRejectedValueOnce(new Error('alerts unavailable'))

    const { result } = renderHook(() => useDashboardOverviewData('1h', null))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.loadError).toBeNull()
    expect(result.current.bundle?.operationalSnapshot?.global.running_streams).toBe(2)
    expect(result.current.bundle?.dashboard).not.toBeNull()
    expect(result.current.bundle?.alerts).toBeNull()
  })

  it('clears the operational snapshot cache on manual reload', async () => {
    const operationalSnapshot = await import('../../api/operationalSnapshot')
    const { result } = renderHook(() => useDashboardOverviewData('1h', null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const snapshotCallsBeforeReload = vi.mocked(operationalSnapshot.getOperationalSnapshot).mock.calls.length
    const clearCallsBeforeReload = vi.mocked(operationalSnapshot.clearOperationalSnapshotCache).mock.calls.length

    await act(async () => {
      await result.current.reload()
    })

    expect(operationalSnapshot.clearOperationalSnapshotCache).toHaveBeenCalledTimes(clearCallsBeforeReload + 1)
    expect(operationalSnapshot.getOperationalSnapshot).toHaveBeenCalledTimes(snapshotCallsBeforeReload + 1)
  })
})
