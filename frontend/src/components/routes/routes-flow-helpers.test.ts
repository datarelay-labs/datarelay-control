import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { buildRouteRowsFromOperationalSnapshot } from './routes-overview-helpers'
import {
  buildDestinationRouteMetrics,
  buildProblemRoutes,
  buildRouteFlowTree,
  aggregateGlobalErrorRateFromRoutes,
} from './routes-flow-helpers'

const snapshot: OperationalSnapshotResponse = {
  global: {
    health_status: 'HEALTHY',
    total_streams: 2,
    enabled_streams: 2,
    running_streams: 2,
    error_streams: 0,
    total_routes: 3,
    enabled_routes: 3,
    total_destinations: 3,
    enabled_destinations: 3,
    total_eps_1m: 10,
    total_eps_5m: 9,
    avg_latency_ms: 12,
    last_activity_at: '2026-05-22T12:00:00Z',
  },
  streams: [
    {
      stream_id: 1,
      stream_name: 'Office365 Events',
      connector_id: 1,
      source_id: 1,
      enabled: true,
      status: 'RUNNING',
      health_status: 'HEALTHY',
      eps_1m: 8.2,
      eps_5m: 8,
      success_rate_5m: 99.7,
      failure_rate_5m: 0.3,
      avg_latency_ms: 10,
      route_count: 2,
      healthy_route_count: 2,
      failed_route_count: 0,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
    {
      stream_id: 2,
      stream_name: 'AWS CloudTrail',
      connector_id: 2,
      source_id: 2,
      enabled: true,
      status: 'RUNNING',
      health_status: 'HEALTHY',
      eps_1m: 6.1,
      eps_5m: 6,
      success_rate_5m: 99.5,
      failure_rate_5m: 0.5,
      avg_latency_ms: 14,
      route_count: 1,
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
      route_id: 1,
      stream_id: 1,
      stream_name: 'Office365 Events',
      destination_id: 10,
      destination_name: 'Stellar Cyber',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      failure_policy: 'LOG_AND_CONTINUE',
      health_status: 'HEALTHY',
      delivered_eps_1m: 3.2,
      failed_eps_1m: 0,
      success_rate_5m: 99.7,
      retry_rate_5m: 0,
      avg_latency_ms: 10,
      last_success_at: '2026-05-22T12:00:00Z',
      last_error_at: null,
      last_error_message: null,
    },
    {
      route_id: 2,
      stream_id: 1,
      stream_name: 'Office365 Events',
      destination_id: 11,
      destination_name: 'Data Lake',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      failure_policy: 'LOG_AND_CONTINUE',
      health_status: 'DEGRADED',
      delivered_eps_1m: 2.4,
      failed_eps_1m: 0.01,
      success_rate_5m: 99.5,
      retry_rate_5m: 0,
      avg_latency_ms: 250,
      last_success_at: '2026-05-22T11:00:00Z',
      last_error_at: '2026-05-22T10:00:00Z',
      last_error_message: 'slow delivery',
    },
    {
      route_id: 3,
      stream_id: 2,
      stream_name: 'AWS CloudTrail',
      destination_id: 12,
      destination_name: 'Datadog',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      failure_policy: 'LOG_AND_CONTINUE',
      health_status: 'HEALTHY',
      delivered_eps_1m: 6.1,
      failed_eps_1m: 0,
      success_rate_5m: 100,
      retry_rate_5m: 0,
      avg_latency_ms: 12,
      last_success_at: '2026-05-22T12:00:00Z',
      last_error_at: null,
      last_error_message: null,
    },
  ],
  destinations: [
    {
      destination_id: 10,
      destination_name: 'Stellar Cyber',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      health_status: 'HEALTHY',
      inbound_eps_1m: 3.2,
      failed_eps_1m: 0,
      avg_latency_ms: 10,
      route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
    },
    {
      destination_id: 11,
      destination_name: 'Data Lake',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      health_status: 'DEGRADED',
      inbound_eps_1m: 2.4,
      failed_eps_1m: 0.01,
      avg_latency_ms: 250,
      route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
    },
    {
      destination_id: 12,
      destination_name: 'Datadog',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      health_status: 'HEALTHY',
      inbound_eps_1m: 6.1,
      failed_eps_1m: 0,
      avg_latency_ms: 12,
      route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
    },
  ],
  problems: [],
  updated_at: '2026-05-22T12:00:00Z',
}

const routesMeta = snapshot.routes.map((r) => ({
  id: r.route_id,
  stream_id: r.stream_id,
  destination_id: r.destination_id,
  enabled: r.enabled,
  failure_policy: r.failure_policy,
  formatter_config_json: {},
  rate_limit_json: {},
  status: 'ENABLED' as const,
}))

describe('routes-flow-helpers', () => {
  const consoleRows = buildRouteRowsFromOperationalSnapshot(snapshot, routesMeta)

  it('builds stream-grouped flow tree with all routes per stream', () => {
    const tree = buildRouteFlowTree(snapshot, consoleRows)
    expect(tree).toHaveLength(2)
    expect(tree[0]?.streamName).toBe('Office365 Events')
    expect(tree[0]?.routes).toHaveLength(2)
    expect(tree[0]?.routes.map((r) => r.destinationName)).toEqual(
      expect.arrayContaining(['Stellar Cyber', 'Data Lake']),
    )
    expect(tree[1]?.streamName).toBe('AWS CloudTrail')
    expect(tree[1]?.routes).toHaveLength(1)
  })

  it('does not substitute delivered route EPS when stream ingest EPS is unavailable', () => {
    const snapshotWithoutStreamEps: OperationalSnapshotResponse = {
      ...snapshot,
      streams: snapshot.streams.map((stream) =>
        stream.stream_id === 1 ? { ...stream, eps_1m: null } : stream,
      ),
    }
    const rows = buildRouteRowsFromOperationalSnapshot(snapshotWithoutStreamEps, routesMeta)
    const tree = buildRouteFlowTree(snapshotWithoutStreamEps, rows)
    const office365 = tree.find((group) => group.streamId === 1)
    expect(office365?.totalEps).toBeNull()
    expect(office365?.routes.map((route) => route.eps)).toEqual(expect.arrayContaining([3.2, 2.4]))
  })

  it('flags warning routes in problem panel', () => {
    const problems = buildProblemRoutes(consoleRows)
    expect(problems.some((p) => p.routeId === 2 && p.issue === 'Warning')).toBe(true)
  })

  it('aggregates destination metrics with matching route counts', () => {
    const metrics = buildDestinationRouteMetrics(snapshot, consoleRows)
    expect(metrics).toHaveLength(3)
    const stellar = metrics.find((m) => m.destinationName === 'Stellar Cyber')
    expect(stellar?.connectedRoutes).toBe(1)
    expect(stellar?.throughputEps).toBe(3.2)
  })

  it('computes global error rate from route eps', () => {
    const err = aggregateGlobalErrorRateFromRoutes(snapshot)
    expect(err).not.toBeNull()
    expect(err!).toBeGreaterThan(0)
    expect(err!).toBeLessThan(1)
  })
})
