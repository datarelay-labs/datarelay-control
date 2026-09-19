import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../api/operationalSnapshot'
import {
  aggregateDeliverySuccessRateFromSnapshot,
  computeSuccessRateFromEps,
  countHealthFromRows,
  deriveOverallHealthPostureFromSnapshot,
  deriveStreamIssuesFromSnapshot,
  formatDestinationOperationalHealth,
  formatOperationalEps,
  formatOperationalHealth,
  formatOperationalSuccessRate,
  formatProblemSummary,
  issueLabelsFromProblems,
  problemsForEntity,
  selectDestinationKpi,
  selectGlobalKpi,
  selectRouteKpi,
  selectStreamKpi,
  streamsSectionKpiFromOperationalSnapshot,
} from './operational-snapshot-selectors'

const snapshotFixture = (): OperationalSnapshotResponse => ({
  global: {
    health_status: 'DEGRADED',
    total_streams: 3,
    enabled_streams: 3,
    running_streams: 2,
    error_streams: 1,
    total_routes: 4,
    enabled_routes: 4,
    total_destinations: 2,
    enabled_destinations: 2,
    total_eps_1m: 12.5,
    total_eps_5m: 11,
    avg_latency_ms: 42,
    last_activity_at: '2026-06-22T12:00:00Z',
  },
  streams: [
    {
      stream_id: 1,
      stream_name: 'Stream A',
      connector_id: 10,
      source_id: 20,
      enabled: true,
      status: 'RUNNING',
      health_status: 'HEALTHY',
      eps_1m: 5,
      eps_5m: 4.8,
      success_rate_5m: 99,
      failure_rate_5m: 1,
      avg_latency_ms: 10,
      route_count: 2,
      healthy_route_count: 2,
      failed_route_count: 0,
      last_success_at: '2026-06-22T11:59:00Z',
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
    {
      stream_id: 2,
      stream_name: 'Stream B',
      connector_id: 11,
      source_id: 21,
      enabled: true,
      status: 'DEGRADED',
      health_status: 'DEGRADED',
      eps_1m: 2,
      eps_5m: 2,
      success_rate_5m: 88,
      failure_rate_5m: 12,
      avg_latency_ms: 80,
      route_count: 1,
      healthy_route_count: 0,
      failed_route_count: 1,
      last_success_at: '2026-06-22T11:50:00Z',
      last_error_at: '2026-06-22T11:55:00Z',
      last_error_message: 'delivery timeout',
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: 120,
    },
    {
      stream_id: 3,
      stream_name: 'Stream C',
      connector_id: 12,
      source_id: 22,
      enabled: false,
      status: 'STOPPED',
      health_status: 'IDLE',
      eps_1m: 0,
      eps_5m: 0,
      success_rate_5m: 0,
      failure_rate_5m: 0,
      avg_latency_ms: null,
      route_count: 0,
      healthy_route_count: 0,
      failed_route_count: 0,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
  ],
  routes: [
    {
      route_id: 100,
      stream_id: 1,
      stream_name: 'Stream A',
      destination_id: 7,
      destination_name: 'Dest 7',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      failure_policy: 'LOG_AND_CONTINUE',
      health_status: 'HEALTHY',
      delivered_eps_1m: 4.5,
      failed_eps_1m: 0.1,
      success_rate_5m: 99.5,
      retry_rate_5m: 1,
      avg_latency_ms: 12,
      last_success_at: '2026-06-22T11:59:00Z',
      last_error_at: null,
      last_error_message: null,
    },
    {
      route_id: 101,
      stream_id: 2,
      stream_name: 'Stream B',
      destination_id: 8,
      destination_name: 'Dest 8',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      failure_policy: 'RETRY_AND_BACKOFF',
      health_status: 'ERROR',
      delivered_eps_1m: 0,
      failed_eps_1m: 2,
      success_rate_5m: 0,
      retry_rate_5m: 20,
      avg_latency_ms: 200,
      last_success_at: null,
      last_error_at: '2026-06-22T11:55:00Z',
      last_error_message: 'connection refused',
    },
  ],
  destinations: [
    {
      destination_id: 7,
      destination_name: 'Dest 7',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      health_status: 'HEALTHY',
      inbound_eps_1m: 4.5,
      failed_eps_1m: 0.1,
      avg_latency_ms: 12,
      route_count: 1,
      last_success_at: '2026-06-22T11:59:00Z',
      last_error_at: null,
      last_error_message: null,
    },
    {
      destination_id: 8,
      destination_name: 'Dest 8',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      health_status: 'ERROR',
      inbound_eps_1m: 0,
      failed_eps_1m: 2,
      avg_latency_ms: 200,
      route_count: 1,
      last_success_at: null,
      last_error_at: '2026-06-22T11:55:00Z',
      last_error_message: 'connection refused',
    },
  ],
  problems: [
    {
      severity: 'critical',
      scope: 'route',
      stream_id: 2,
      route_id: 101,
      destination_id: 8,
      title: 'Route failure',
      message: 'connection refused',
      last_seen_at: '2026-06-22T11:55:00Z',
    },
    {
      severity: 'warning',
      scope: 'stream',
      stream_id: 2,
      route_id: null,
      destination_id: null,
      title: 'Degraded stream',
      message: 'delivery timeout',
      last_seen_at: '2026-06-22T11:55:00Z',
    },
  ],
  updated_at: '2026-06-22T12:00:00Z',
})

describe('operational-snapshot-selectors', () => {
  const snapshot = snapshotFixture()

  it('formats health, EPS, and success rate consistently', () => {
    expect(formatOperationalHealth('HEALTHY').label).toBe('Healthy')
    expect(formatOperationalHealth('DEGRADED').label).toBe('Warning')
    expect(formatOperationalHealth('ERROR').label).toBe('Error')
    expect(formatOperationalHealth('IDLE').label).toBe('No Data')
    expect(formatOperationalHealth('HEALTHY', false).label).toBe('Disabled')
    expect(formatOperationalHealth('IDLE', false, 'STOPPED').label).toBe('Stopped')
    expect(formatOperationalHealth('HEALTHY', true, 'STOPPED').label).toBe('Stopped')
    expect(formatDestinationOperationalHealth('ERROR').label).toBe('Critical')
    expect(formatOperationalEps(3.5)).toContain('3.5')
    expect(formatOperationalSuccessRate(92.5)).toBe('92.5%')
    expect(computeSuccessRateFromEps(9, 1)).toBe(90)
  })

  it('selects global KPI from snapshot', () => {
    const kpi = selectGlobalKpi(snapshot)
    expect(kpi.runningStreams).toBe(2)
    expect(kpi.errorStreams).toBe(1)
    expect(kpi.eps1m).toBe(12.5)
    expect(kpi.health.label).toBe('Warning')
  })

  it('selects stream KPI with shared health/EPS/success across entities', () => {
    const streamA = selectStreamKpi(snapshot.streams[0]!, snapshot.problems)
    const streamB = selectStreamKpi(snapshot.streams[1]!, snapshot.problems)
    expect(streamA.health.label).toBe('Healthy')
    expect(streamA.eps1m).toBe(5)
    expect(streamA.successRatePct).toBe(99)
    expect(streamA.runtimeStatus).toBe('RUNNING')
    expect(streamB.health.label).toBe('Warning')
    expect(streamB.successRatePct).toBe(88)
    expect(streamB.issues).toContain('delivery timeout')
    const streamC = selectStreamKpi(snapshot.streams[2]!, snapshot.problems)
    expect(streamC.successRatePct).toBeNull()
    expect(streamC.successLabel).toBe('—')
  })

  it('prefers runtime status field over health-derived status', () => {
    const stream = {
      ...snapshot.streams[0]!,
      status: 'RUNNING',
      health_status: 'IDLE' as const,
      enabled: true,
    }
    const kpi = selectStreamKpi(stream, snapshot.problems)
    expect(kpi.runtimeStatus).toBe('RUNNING')
  })

  it('selects route and destination KPI from the same snapshot fixture', () => {
    const route = selectRouteKpi(snapshot.routes[1]!, snapshot.problems)
    const dest = selectDestinationKpi(snapshot.destinations[1]!, snapshot.problems)
    expect(route.health.label).toBe('Error')
    expect(route.successRatePct).toBe(0)
    expect(route.issues).toContain('connection refused')
    expect(dest.health.label).toBe('Critical')
    expect(dest.successRatePct).toBe(0)
    expect(dest.issues).toContain('connection refused')
  })

  it('derives dashboard and streams section KPI from snapshot', () => {
    const posture = deriveOverallHealthPostureFromSnapshot(snapshot)
    expect(posture).toEqual({ healthy: 1, warning: 1, critical: 0, posture: 'warning' })
    const success = aggregateDeliverySuccessRateFromSnapshot(snapshot)
    expect(success).not.toBeNull()
    const section = streamsSectionKpiFromOperationalSnapshot(snapshot)
    expect(section.total).toBe(3)
    expect(section.running).toBe(2)
    expect(section.error).toBe(1)
  })

  it('filters problems and formats issue labels', () => {
    const routeProblems = problemsForEntity(snapshot.problems, 'route', 101)
    expect(routeProblems).toHaveLength(1)
    expect(issueLabelsFromProblems(routeProblems)).toEqual(['connection refused'])
    expect(formatProblemSummary(null, 'ERROR')).toBe('Delivery error')
    expect(deriveStreamIssuesFromSnapshot(snapshot.streams[1]!, snapshot.problems)).toContain('delivery timeout')
  })

  it('counts health buckets from snapshot rows', () => {
    expect(countHealthFromRows(snapshot.streams)).toEqual({
      healthy: 1,
      warning: 1,
      critical: 0,
      idle: 0,
      disabled: 1,
    })
  })
})
