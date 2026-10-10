import { describe, expect, it } from 'vitest'
import type { DestinationListItem } from '../../api/gdcDestinations'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { DestinationHealthRow } from '../../api/types/gdcApi'
import {
  buildDestinationRuntimeLookup,
  destinationDeliveryMetricsFromHealthRow,
  destinationIssuesForListRow,
  destinationUiHealthForListRow,
  listRuntimeMetricsForDestination,
  routeMetricsFromSnapshot,
} from './destination-runtime-metrics'

function catalogRow(id: number, enabled = true): DestinationListItem {
  return {
    id,
    name: `Dest ${id}`,
    destination_type: 'SYSLOG_UDP',
    config_json: { host: '10.0.0.1', port: 514 },
    rate_limit_json: {},
    enabled,
    streams_using_count: 2,
    routes: [
      { route_id: 10, stream_id: 1, stream_name: 'Stream A', route_enabled: true, route_status: 'ENABLED' },
      { route_id: 11, stream_id: 2, stream_name: 'Stream B', route_enabled: true, route_status: 'ENABLED' },
    ],
    created_at: null,
    updated_at: null,
  }
}

function healthRow(overrides: Partial<DestinationHealthRow> = {}): DestinationHealthRow {
  return {
    destination_id: 7,
    destination_name: 'Dest 7',
    destination_type: 'SYSLOG_UDP',
    score: 40,
    level: 'CRITICAL',
    factors: [
      {
        code: 'failure_rate',
        label: 'High failure rate',
        delta: -20,
        detail: 'Delivery failures exceeded threshold',
      },
    ],
    metrics: {
      failure_count: 10,
      success_count: 90,
      retry_event_count: 0,
      retry_count_sum: 0,
      failure_rate: 0.1,
      retry_rate: 0,
      latency_ms_avg: 10,
      latency_ms_p95: 20,
      last_failure_at: '2026-06-23T10:00:00Z',
      last_success_at: null,
      historical_failure_count: 10,
      historical_delivery_failure_rate: 0.1,
      live_delivery_failure_rate: 0.1,
      recent_success_ratio: 0.9,
      health_recovery_score: 0.5,
      recent_failure_count: 2,
      recent_success_count: 8,
      recent_failure_rate: 0.2,
      recent_window_since: null,
      recent_window_until: null,
      current_runtime_health: 'CRITICAL',
    },
    ...overrides,
  }
}

describe('Route success-rate snapshot window integrity', () => {
  it('exposes a measured failed-only 5m rate as 0% instead of hiding it as unknown', () => {
    const r = {
      route_id: 41, success_rate_5m: 0, delivered_eps_1m: 0, failed_eps_1m: 2,
      enabled: true, health_status: 'ERROR', failure_policy: 'LOG_AND_CONTINUE',
    } as OperationalSnapshotResponse['routes'][number]
    const metrics = routeMetricsFromSnapshot(41, [r], [])
    expect(metrics.successRate5m).toBe(0)
    expect(metrics).not.toHaveProperty('successRate24h')
  })

  it('does not invent historical or measured success where no Route snapshot or recent sample exists', () => {
    expect(routeMetricsFromSnapshot(41, [], []).successRate5m).toBeNull()
    const r = {
      route_id: 41, success_rate_5m: 0, delivered_eps_1m: 0, failed_eps_1m: 0,
      enabled: true, health_status: 'IDLE', failure_policy: 'LOG_AND_CONTINUE',
    } as OperationalSnapshotResponse['routes'][number]
    expect(routeMetricsFromSnapshot(41, [r], []).successRate5m).toBeNull()
  })
})

describe('destination-runtime-metrics', () => {
  it('builds list runtime metrics from health API for the selected window', () => {
    const snapshot: OperationalSnapshotResponse = {
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
        total_eps_1m: 10,
        total_eps_5m: 10,
        avg_latency_ms: 12,
        last_activity_at: null,
      },
      streams: [],
      routes: [],
      destinations: [
        {
          destination_id: 7,
          destination_name: 'Dest 7',
          destination_type: 'SYSLOG_UDP',
          enabled: true,
          health_status: 'HEALTHY',
          inbound_eps_1m: 4.2,
          failed_eps_1m: 0.8,
          avg_latency_ms: 10,
          route_count: 2,
          last_success_at: null,
          last_error_at: null,
          last_error_message: null,
        },
      ],
      problems: [],
      updated_at: '2026-06-22T00:00:00Z',
    }
    const lookup = buildDestinationRuntimeLookup(snapshot)
    const row = {
      ...catalogRow(7),
      rate_limit_json: {
        capacity_limit_eps: 5,
        capacity_warning_threshold_pct: 70,
        capacity_critical_threshold_pct: 85,
      },
    }
    const metrics = listRuntimeMetricsForDestination(row, lookup, snapshot, healthRow(), '1h')
    expect(metrics.connectedStreams).toBe(2)
    expect(metrics.connectedRoutes).toBe(2)
    expect(metrics.currentEps).toBeCloseTo(100 / 3600, 4)
    expect(metrics.successRatePct).toBe(90)
    expect(metrics.hasDeliveryActivity).toBe(true)
    expect(metrics.capacityUsagePct).toBeCloseTo(84, 4)
    expect(metrics.capacityWarning).toBe(true)
    expect(metrics.health).toBe('Critical')
    expect(metrics.recentIssues.length).toBeGreaterThan(0)
  })

  it('prefers catalog route count over stale snapshot route_count', () => {
    const snapshot: OperationalSnapshotResponse = {
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
        total_eps_1m: 0,
        total_eps_5m: 0,
        avg_latency_ms: null,
        last_activity_at: null,
      },
      streams: [],
      routes: [],
      destinations: [
        {
          destination_id: 7,
          destination_name: 'Dest 7',
          destination_type: 'SYSLOG_UDP',
          enabled: true,
          health_status: 'HEALTHY',
          inbound_eps_1m: 0,
          failed_eps_1m: 0,
          avg_latency_ms: null,
          route_count: 122,
          last_success_at: null,
          last_error_at: null,
          last_error_message: null,
        },
      ],
      problems: [],
      updated_at: '2026-06-22T00:00:00Z',
    }
    const lookup = buildDestinationRuntimeLookup(snapshot)
    const metrics = listRuntimeMetricsForDestination(catalogRow(7), lookup, snapshot, null, '1h')
    expect(metrics.connectedRoutes).toBe(2)
    expect(metrics.currentEps).toBeNull()
    expect(metrics.successRatePct).toBeNull()
    expect(metrics.hasDeliveryActivity).toBe(false)
  })

  it('shows connectivity test failures in issues and health', () => {
    const row = {
      ...catalogRow(99),
      last_connectivity_test_success: false,
      last_connectivity_test_message: 'Connection refused',
      last_connectivity_test_at: '2026-06-23T10:00:00Z',
    }
    expect(destinationUiHealthForListRow(row, null, null, undefined)).toBe('Critical')
    expect(destinationIssuesForListRow(row, null)).toContain('Connection refused')
  })

  it('derives delivery metrics from health row counts', () => {
    const metrics = destinationDeliveryMetricsFromHealthRow(healthRow(), '1h')
    expect(metrics.successRatePct).toBe(90)
    expect(metrics.hasDeliveryActivity).toBe(true)
    expect(metrics.currentEps).toBeCloseTo(100 / 3600, 4)
  })

  it('returns idle health without snapshot row instead of fake healthy', () => {
    const lookup = buildDestinationRuntimeLookup(null)
    const metrics = listRuntimeMetricsForDestination(catalogRow(99), lookup, null, null, '1h')
    expect(metrics.currentEps).toBeNull()
    expect(metrics.successRatePct).toBeNull()
    expect(metrics.hasDeliveryActivity).toBe(false)
    expect(metrics.health).toBe('Idle')
  })

  it('shows healthy when connectivity test passed but runtime snapshot is absent', () => {
    const lookup = buildDestinationRuntimeLookup(null)
    const row = {
      ...catalogRow(99),
      last_connectivity_test_success: true,
      last_connectivity_test_at: '2026-06-23T10:00:00Z',
    }
    const metrics = listRuntimeMetricsForDestination(row, lookup, null, null, '1h')
    expect(metrics.health).toBe('Healthy')
  })
})
