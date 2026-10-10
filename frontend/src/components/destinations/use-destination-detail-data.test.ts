import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDestinationDetailData } from './use-destination-detail-data'

const fetchDestinationById = vi.fn()
const getOperationalSnapshot = vi.fn()
const fetchDestinationHealthList = vi.fn()
const fetchRouteHealthList = vi.fn()
const fetchRouteFailuresAnalytics = vi.fn()
const fetchDeliveryOutcomesByDestination = vi.fn()
const searchRuntimeDeliveryLogs = vi.fn()
const testDestination = vi.fn()

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationById: (...args: unknown[]) => fetchDestinationById(...args),
  testDestination: (...args: unknown[]) => testDestination(...args),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  getOperationalSnapshot: (...args: unknown[]) => getOperationalSnapshot(...args),
}))

vi.mock('../../api/gdcRuntimeHealth', () => ({
  fetchDestinationHealthList: (...args: unknown[]) => fetchDestinationHealthList(...args),
  fetchRouteHealthList: (...args: unknown[]) => fetchRouteHealthList(...args),
}))

vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchRouteFailuresAnalytics: (...args: unknown[]) => fetchRouteFailuresAnalytics(...args),
  fetchDeliveryOutcomesByDestination: (...args: unknown[]) => fetchDeliveryOutcomesByDestination(...args),
}))

vi.mock('../../api/gdcRuntime', () => ({
  searchRuntimeDeliveryLogs: (...args: unknown[]) => searchRuntimeDeliveryLogs(...args),
}))

function detail(id: number, name: string) {
  return {
    id,
    name,
    destination_type: 'WEBHOOK_POST',
    config_json: { url: `https://example.com/${id}` },
    rate_limit_json: {},
    enabled: true,
  }
}

function emptyRuntime() {
  getOperationalSnapshot.mockResolvedValue({
    global: {
      health_status: 'HEALTHY',
      total_streams: 0,
      enabled_streams: 0,
      running_streams: 0,
      error_streams: 0,
      total_routes: 0,
      enabled_routes: 0,
      total_destinations: 0,
      enabled_destinations: 0,
      total_eps_1m: 0,
      total_eps_5m: 0,
      avg_latency_ms: 0,
      last_activity_at: null,
    },
    streams: [],
    routes: [],
    destinations: [],
    problems: [],
    updated_at: '2026-08-10T00:00:00Z',
  })
  fetchDestinationHealthList.mockResolvedValue({ rows: [] })
  fetchRouteHealthList.mockResolvedValue({ rows: [] })
  fetchRouteFailuresAnalytics.mockResolvedValue(null)
  fetchDeliveryOutcomesByDestination.mockResolvedValue({ rows: [] })
  searchRuntimeDeliveryLogs.mockResolvedValue({ logs: [] })
}

describe('useDestinationDetailData ownership + stale protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emptyRuntime()
  })

  it('loads destination once per id (no duplicate ownership fan-out on mount)', async () => {
    fetchDestinationById.mockResolvedValue(detail(7, 'Dest-7'))
    const { result } = renderHook(() => useDestinationDetailData(7))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))
    expect(fetchDestinationById).toHaveBeenCalledTimes(1)
    expect(fetchDestinationById).toHaveBeenCalledWith(7)
    expect(result.current.destination?.name).toBe('Dest-7')
  })

  it('does not treat a failed 24h analytics fetch as zero failed Destination events', async () => {
    fetchDestinationById.mockResolvedValue(detail(7, 'Dest-7'))
    fetchRouteFailuresAnalytics.mockRejectedValueOnce(new Error('historical analytics offline'))
    const { result } = renderHook(() => useDestinationDetailData(7))
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))
    expect(result.current.destination?.id).toBe(7)
    expect(result.current.failed24h).toBeNull()
  })

  it('initial load skips route-health (snapshot owns route EPS/status)', async () => {
    fetchDestinationById.mockResolvedValue(detail(7, 'Dest-7'))
    const { result } = renderHook(() => useDestinationDetailData(7))
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))

    expect(fetchDestinationById).toHaveBeenCalledTimes(1)
    expect(getOperationalSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchDestinationHealthList).toHaveBeenCalledTimes(1)
    expect(fetchRouteFailuresAnalytics).toHaveBeenCalledTimes(1)
    expect(fetchDeliveryOutcomesByDestination).toHaveBeenCalledTimes(1)
    expect(searchRuntimeDeliveryLogs).toHaveBeenCalledTimes(1)
    expect(fetchRouteHealthList).not.toHaveBeenCalled()
  })

  it('manual refresh and connectivity test keep route-health off the core fan-out', async () => {
    fetchDestinationById
      .mockResolvedValueOnce(detail(3, 'Before'))
      .mockResolvedValueOnce(detail(3, 'After-Refresh'))
      .mockResolvedValueOnce(detail(3, 'After-Test'))
    testDestination.mockResolvedValue({
      success: true,
      latency_ms: 12,
      message: 'ok',
      tested_at: '2026-08-10T00:00:00Z',
    })

    const { result } = renderHook(() => useDestinationDetailData(3))
    await waitFor(() => expect(result.current.destination?.name).toBe('Before'))
    expect(fetchRouteHealthList).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.destination?.name).toBe('After-Refresh'))
    expect(fetchRouteHealthList).not.toHaveBeenCalled()

    await act(async () => {
      const out = await result.current.runConnectivityTest()
      expect(out.success).toBe(true)
    })
    await waitFor(() => expect(result.current.destination?.name).toBe('After-Test'))
    expect(fetchRouteHealthList).not.toHaveBeenCalled()
    expect(fetchDestinationById).toHaveBeenCalledTimes(3)
  })

  it('ignores stale destination A response after switching to B', async () => {
    let resolveA: (value: ReturnType<typeof detail>) => void = () => undefined
    const slowA = new Promise<ReturnType<typeof detail>>((resolve) => {
      resolveA = resolve
    })
    fetchDestinationById.mockImplementation(async (id: number) => {
      if (id === 1) return slowA
      return detail(2, 'Dest-B')
    })

    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useDestinationDetailData(id),
      { initialProps: { id: 1 } },
    )

    rerender({ id: 2 })
    await waitFor(() => expect(result.current.destination?.id).toBe(2))
    expect(result.current.destination?.name).toBe('Dest-B')

    await act(async () => {
      resolveA(detail(1, 'Dest-A-STALE'))
      await Promise.resolve()
    })

    expect(result.current.destination?.id).toBe(2)
    expect(result.current.destination?.name).toBe('Dest-B')
  })

  it('derives connected route EPS/status from snapshot without route-health', async () => {
    fetchDestinationById.mockResolvedValue(detail(9, 'Dest-9'))
    getOperationalSnapshot.mockResolvedValue({
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
        total_eps_5m: 4,
        avg_latency_ms: 10,
        last_activity_at: null,
      },
      streams: [],
      routes: [
        {
          route_id: 41,
          stream_id: 12,
          stream_name: 'Stream A',
          destination_id: 9,
          destination_name: 'Dest-9',
          destination_type: 'WEBHOOK_POST',
          enabled: true,
          failure_policy: 'LOG_AND_CONTINUE',
          health_status: 'HEALTHY',
          delivered_eps_1m: 4.5,
          failed_eps_1m: 0,
          success_rate_5m: 99,
          retry_rate_5m: 0,
          avg_latency_ms: 8,
          last_success_at: null,
          last_error_at: null,
          last_error_message: null,
        },
      ],
      destinations: [
        {
          destination_id: 9,
          destination_name: 'Dest-9',
          destination_type: 'WEBHOOK_POST',
          enabled: true,
          health_status: 'HEALTHY',
          inbound_eps_1m: 4.5,
          failed_eps_1m: 0,
          avg_latency_ms: 8,
          route_count: 1,
          last_success_at: null,
          last_error_at: null,
          last_error_message: null,
        },
      ],
      problems: [],
      updated_at: '2026-08-10T00:00:00Z',
    })

    const { result } = renderHook(() => useDestinationDetailData(9))
    await waitFor(() => expect(result.current.runtimeLoading).toBe(false))
    expect(fetchRouteHealthList).not.toHaveBeenCalled()
    expect(result.current.connectedRoutes).toHaveLength(1)
    expect(result.current.connectedRoutes[0]?.epsAvg).toBe(4.5)
    expect(result.current.connectedRoutes[0]?.status).toBe('ACTIVE')
    expect(result.current.connectedRoutes[0]?.deliveryMode).toBe('LOG_AND_CONTINUE')
  })
})
