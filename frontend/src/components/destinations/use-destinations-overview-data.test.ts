import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useDestinationsOverviewData } from './use-destinations-overview-data'
import { clearDestinationsListSnapshot } from './destinations-list-cache'

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [
    {
      id: 1,
      name: 'Webhook',
      destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://example.com/hook' },
      rate_limit_json: {},
      enabled: true,
      streams_using_count: 1,
      routes: [{ route_id: 3, stream_id: 9, stream_name: 'S9', route_enabled: true, route_status: 'ENABLED' }],
      created_at: null,
      updated_at: null,
      last_connectivity_test_success: true,
      last_connectivity_test_at: '2026-06-23T10:00:00Z',
    },
  ]),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  getOperationalSnapshot: vi.fn(async () => ({
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
      total_eps_1m: 2.5,
      total_eps_5m: 2.5,
      avg_latency_ms: 8,
      last_activity_at: null,
    },
    streams: [],
    routes: [
      {
        route_id: 3,
        stream_id: 9,
        stream_name: 'S9',
        destination_id: 1,
        destination_name: 'Webhook',
        destination_type: 'WEBHOOK_POST',
        enabled: true,
        failure_policy: 'retry',
        health_status: 'HEALTHY',
        delivered_eps_1m: 2.5,
        failed_eps_1m: 0,
        success_rate_5m: 100,
        retry_rate_5m: 0,
        avg_latency_ms: 8,
        last_success_at: null,
        last_error_at: null,
        last_error_message: null,
      },
    ],
    destinations: [
      {
        destination_id: 1,
        destination_name: 'Webhook',
        destination_type: 'WEBHOOK_POST',
        enabled: true,
        health_status: 'HEALTHY',
        inbound_eps_1m: 2.5,
        failed_eps_1m: 0,
        avg_latency_ms: 8,
        route_count: 1,
        last_success_at: null,
        last_error_at: null,
        last_error_message: null,
      },
    ],
    problems: [],
    updated_at: '2026-06-22T00:00:00Z',
  })),
  clearOperationalSnapshotCache: vi.fn(),
}))

vi.mock('../../api/gdcRuntimeHealth', () => ({
  clearDestinationHealthCache: vi.fn(),
  fetchDestinationHealthList: vi.fn(async () => ({
    time: { token: '1h', since: '2026-06-23T09:00:00Z', until: '2026-06-23T10:00:00Z' },
    filters: {},
    scoring_mode: 'historical_analytics',
    rows: [
      {
        destination_id: 1,
        destination_name: 'Webhook',
        destination_type: 'WEBHOOK_POST',
        score: 95,
        level: 'HEALTHY',
        factors: [],
        metrics: {
          failure_count: 0,
          success_count: 3600,
          retry_event_count: 0,
          retry_count_sum: 0,
          failure_rate: 0,
          retry_rate: 0,
          latency_ms_avg: 8,
          latency_ms_p95: 12,
          last_failure_at: null,
          last_success_at: '2026-06-23T10:00:00Z',
          historical_failure_count: 0,
          historical_delivery_failure_rate: 0,
          live_delivery_failure_rate: 0,
          recent_success_ratio: 1,
          health_recovery_score: 1,
          recent_failure_count: 0,
          recent_success_count: 3600,
          recent_failure_rate: 0,
          recent_window_since: null,
          recent_window_until: null,
          current_runtime_health: 'HEALTHY',
        },
      },
    ],
  })),
}))

describe('useDestinationsOverviewData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearDestinationsListSnapshot()
  })

  it('merges catalog rows with health API metrics for the selected window', async () => {
    const { result } = renderHook(() =>
      useDestinationsOverviewData({ timeRange: '1h', refreshVersion: 0 }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]?.runtime.connectedRoutes).toBe(1)
    expect(result.current.rows[0]?.runtime.currentEps).toBe(1)
    expect(result.current.rows[0]?.runtime.successRatePct).toBe(100)
    expect(result.current.rows[0]?.runtime.hasDeliveryActivity).toBe(true)
    expect(result.current.rows[0]?.runtime.health).toBe('Healthy')
    expect(result.current.runtimeError).toBeNull()
  })

  it('surfaces runtime error when operational snapshot is unavailable and reads Connectivity verified, not Healthy, without delivery evidence', async () => {
    const operationalSnapshot = await import('../../api/operationalSnapshot')
    vi.mocked(operationalSnapshot.getOperationalSnapshot).mockResolvedValueOnce(null)
    const health = await import('../../api/gdcRuntimeHealth')
    vi.mocked(health.fetchDestinationHealthList).mockResolvedValueOnce(null)
    const { result } = renderHook(() =>
      useDestinationsOverviewData({ timeRange: '1h', refreshVersion: 1 }),
    )
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))
    expect(result.current.runtimeError).toMatch(/runtime data/i)
    expect(result.current.rows[0]?.runtime.health).toBe('Connectivity verified \u00b7 No deliveries observed')
  })

  it('keeps newest refresh generation when an older runtime response arrives late', async () => {
    const operationalSnapshot = await import('../../api/operationalSnapshot')
    const health = await import('../../api/gdcRuntimeHealth')
    let resolveSlow: (value: unknown) => void = () => undefined
    const slow = new Promise((resolve) => {
      resolveSlow = resolve
    })
    vi.mocked(operationalSnapshot.getOperationalSnapshot)
      .mockImplementationOnce(() => slow as Promise<never>)
      .mockResolvedValueOnce({
        global: {
          health_status: 'WARNING',
          total_streams: 1,
          enabled_streams: 1,
          running_streams: 0,
          error_streams: 0,
          total_routes: 1,
          enabled_routes: 1,
          total_destinations: 1,
          enabled_destinations: 1,
          total_eps_1m: 0.5,
          total_eps_5m: 0.5,
          avg_latency_ms: 40,
          last_activity_at: null,
        },
        streams: [],
        routes: [],
        destinations: [
          {
            destination_id: 1,
            destination_name: 'Webhook',
            destination_type: 'WEBHOOK_POST',
            enabled: true,
            health_status: 'WARNING',
            inbound_eps_1m: 0.5,
            failed_eps_1m: 0.2,
            avg_latency_ms: 40,
            route_count: 1,
            last_success_at: null,
            last_error_at: null,
            last_error_message: null,
          },
        ],
        problems: [],
        updated_at: '2026-06-23T00:00:00Z',
      })
    vi.mocked(health.fetchDestinationHealthList).mockResolvedValue({
      time: { token: '1h', since: '2026-06-23T09:00:00Z', until: '2026-06-23T10:00:00Z' },
      filters: {},
      scoring_mode: 'historical_analytics',
      rows: [],
    })

    const { result, rerender } = renderHook(
      ({ refreshVersion }: { refreshVersion: number }) =>
        useDestinationsOverviewData({ timeRange: '1h', refreshVersion }),
      { initialProps: { refreshVersion: 0 } },
    )

    rerender({ refreshVersion: 1 })
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))
    expect(result.current.rows[0]?.runtime.currentEps).toBe(0.5)

    await act(async () => {
      resolveSlow({
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
          total_eps_1m: 99,
          total_eps_5m: 99,
          avg_latency_ms: 1,
          last_activity_at: null,
        },
        streams: [],
        routes: [],
        destinations: [
          {
            destination_id: 1,
            destination_name: 'Webhook',
            destination_type: 'WEBHOOK_POST',
            enabled: true,
            health_status: 'HEALTHY',
            inbound_eps_1m: 99,
            failed_eps_1m: 0,
            avg_latency_ms: 1,
            route_count: 1,
            last_success_at: null,
            last_error_at: null,
            last_error_message: null,
          },
        ],
        problems: [],
        updated_at: '2026-06-22T00:00:00Z',
      })
      await Promise.resolve()
    })

    expect(result.current.rows[0]?.runtime.currentEps).toBe(0.5)
  })

  it('issues one catalog + one runtime pair per refresh version (no duplicate ownership)', async () => {
    const destinations = await import('../../api/gdcDestinations')
    const operationalSnapshot = await import('../../api/operationalSnapshot')
    const health = await import('../../api/gdcRuntimeHealth')
    renderHook(() => useDestinationsOverviewData({ timeRange: '1h', refreshVersion: 2 }))
    await waitFor(() => expect(vi.mocked(destinations.fetchDestinationsList)).toHaveBeenCalled())
    await waitFor(() => expect(vi.mocked(operationalSnapshot.getOperationalSnapshot)).toHaveBeenCalled())
    expect(vi.mocked(destinations.fetchDestinationsList)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(operationalSnapshot.getOperationalSnapshot)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(health.fetchDestinationHealthList)).toHaveBeenCalledTimes(1)
  })
})
