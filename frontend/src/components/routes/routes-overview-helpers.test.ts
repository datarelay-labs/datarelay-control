import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import {
  buildRouteConsoleRows,
  buildRouteRowsFromOperationalSnapshot,
  filterRouteConsoleRows,
  formatEps,
  formatSuccessRate,
  getLastActivityAt,
  getRouteHealthPresentation,
  getRouteProblemSummary,
  metricsFromOperationalRoute,
} from './routes-overview-helpers'
import type { RouteRead } from '../../api/gdcRoutes'
import type { DestinationListItem } from '../../api/gdcDestinations'
import type { RouteRuntimeMetricsRow, StreamRead } from '../../api/types/gdcApi'

describe('buildRouteConsoleRows', () => {
  it('classifies route rows from metrics when health API is not used', () => {
    const routes: RouteRead[] = [
      {
        id: 10,
        stream_id: 1,
        destination_id: 2,
        name: 'r',
        enabled: true,
        failure_policy: 'LOG_AND_CONTINUE',
        formatter_config_json: {},
        rate_limit_json: {},
        status: 'ENABLED',
      },
    ]
    const streams: StreamRead[] = [{ id: 1, name: 's', connector_id: 1, source_id: 1, status: 'RUNNING' }]
    const destinations: DestinationListItem[] = [
      {
        id: 2,
        name: 'd',
        destination_type: 'WEBHOOK_POST',
        enabled: true,
        config_json: {},
        rate_limit_json: {},
        created_at: null,
        updated_at: null,
        streams_using_count: 1,
        routes: [],
      },
    ]
    const metrics: RouteRuntimeMetricsRow = {
      route_id: 10,
      destination_id: 2,
      destination_name: 'd',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      route_status: 'ENABLED',
      success_rate: 92,
      events_last_hour: 100,
      delivered_last_hour: 92,
      failed_last_hour: 8,
      avg_latency_ms: 120,
      p95_latency_ms: 120,
      max_latency_ms: 120,
      eps_current: 1.2,
      retry_count_last_hour: 0,
      last_success_at: null,
      last_failure_at: null,
      last_error_message: null,
      last_error_code: null,
      failure_policy: 'LOG_AND_CONTINUE',
      connectivity_state: 'DEGRADED',
      disable_reason: null,
      latency_trend: [],
      success_rate_trend: [],
    }

    const rows = buildRouteConsoleRows(routes, streams, destinations, new Map([[10, metrics]]))
    expect(rows[0]?.uiStatus).toBe('Warning')
  })
})

describe('buildRouteRowsFromOperationalSnapshot', () => {
  const snapshot: OperationalSnapshotResponse = {
    global: {
      health_status: 'DEGRADED',
      total_streams: 1,
      enabled_streams: 1,
      running_streams: 1,
      error_streams: 0,
      total_routes: 1,
      enabled_routes: 1,
      total_destinations: 1,
      enabled_destinations: 1,
      total_eps_1m: 1,
      total_eps_5m: 1,
      avg_latency_ms: 20,
      last_activity_at: '2026-05-22T11:00:00Z',
    },
    streams: [],
    routes: [
      {
        route_id: 42,
        stream_id: 7,
        stream_name: 'Ops stream',
        destination_id: 9,
        destination_name: 'Syslog sink',
        destination_type: 'SYSLOG_UDP',
        enabled: true,
        failure_policy: 'RETRY_AND_BACKOFF',
        health_status: 'DEGRADED',
        delivered_eps_1m: 3.5,
        failed_eps_1m: 0.2,
        success_rate_5m: 92.5,
        retry_rate_5m: 4,
        avg_latency_ms: 180,
        last_success_at: '2026-05-22T11:59:00Z',
        last_error_at: '2026-05-22T11:58:00Z',
        last_error_message: 'connection reset',
      },
    ],
    destinations: [],
    problems: [],
    updated_at: '2026-05-22T12:00:00Z',
  }

  it('prefers API stream and destination metadata over snapshot stubs', () => {
    const streams: StreamRead[] = [
      { id: 7, name: 'Real stream', connector_id: 3, source_id: 4, status: 'STOPPED' },
    ]
    const destinations: DestinationListItem[] = [
      {
        id: 9,
        name: 'Real dest',
        destination_type: 'SYSLOG_UDP',
        enabled: true,
        config_json: {},
        rate_limit_json: {},
        created_at: null,
        updated_at: null,
        streams_using_count: 1,
        routes: [],
      },
    ]
    const rows = buildRouteRowsFromOperationalSnapshot(snapshot, [], { streams, destinations })
    expect(rows[0]?.stream?.status).toBe('STOPPED')
    expect(rows[0]?.stream?.connector_id).toBe(3)
    expect(rows[0]?.destination?.name).toBe('Real dest')
  })

  it('maps snapshot route fields into console rows', () => {
    const rows = buildRouteRowsFromOperationalSnapshot(snapshot, [])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.uiStatus).toBe('Warning')
    expect(rows[0]?.stream?.name).toBe('Ops stream')
    expect(rows[0]?.destination?.name).toBe('Syslog sink')
    expect(rows[0]?.metrics?.eps_current).toBe(3.5)
    expect(rows[0]?.metrics?.success_rate).toBe(92.5)
    expect(rows[0]?.metrics?.avg_latency_ms).toBe(180)
    expect(rows[0]?.metrics?.last_error_message).toBe('connection reset')
  })

  it('exposes snapshot helper utilities', () => {
    const route = snapshot.routes[0]!
    expect(getRouteHealthPresentation(route.health_status).uiStatus).toBe('Warning')
    expect(formatEps(route.delivered_eps_1m)).toContain('3.5')
    expect(formatSuccessRate(route.success_rate_5m)).toBe('92.5%')
    expect(getLastActivityAt(route)).toBe('2026-05-22T11:59:00Z')
    expect(getRouteProblemSummary(route)).toBe('connection reset')
    expect(metricsFromOperationalRoute(route).failed_last_hour).toBe(Math.round(0.2 * 60))
  })

  it('applies debounced-style search and quick filters', () => {
    const rows = buildRouteRowsFromOperationalSnapshot(snapshot, [])
    const all = filterRouteConsoleRows(rows, {
      searchQuery: '',
      streamFilter: '__all__',
      destinationFilter: '__all__',
      statusFilter: '__all__',
      policyFilter: '__all__',
      quickFilter: 'all',
      highErr: false,
      highLat: false,
    })
    expect(all).toHaveLength(1)
    const warningOnly = filterRouteConsoleRows(rows, {
      searchQuery: '',
      streamFilter: '__all__',
      destinationFilter: '__all__',
      statusFilter: '__all__',
      policyFilter: '__all__',
      quickFilter: 'warning',
      highErr: false,
      highLat: false,
    })
    expect(warningOnly).toHaveLength(1)
    expect(
      filterRouteConsoleRows(rows, {
        searchQuery: 'missing',
        streamFilter: '__all__',
        destinationFilter: '__all__',
        statusFilter: '__all__',
        policyFilter: '__all__',
        quickFilter: 'all',
        highErr: false,
        highLat: false,
      }),
    ).toHaveLength(0)
  })

  it('filters duplicate-name streams by stable stream ID', () => {
    const duplicateNameSnapshot: OperationalSnapshotResponse = {
      ...snapshot,
      routes: [
        snapshot.routes[0]!,
        {
          ...snapshot.routes[0]!,
          route_id: 43,
          stream_id: 8,
          stream_name: 'Ops stream',
        },
      ],
    }
    const rows = buildRouteRowsFromOperationalSnapshot(duplicateNameSnapshot, [])
    const selected = filterRouteConsoleRows(rows, {
      searchQuery: '',
      streamFilter: '8',
      destinationFilter: '__all__',
      statusFilter: '__all__',
      policyFilter: '__all__',
      quickFilter: 'all',
      highErr: false,
      highLat: false,
    })

    expect(selected).toHaveLength(1)
    expect(selected[0]?.route.id).toBe(43)
    expect(selected[0]?.route.stream_id).toBe(8)
  })
})
