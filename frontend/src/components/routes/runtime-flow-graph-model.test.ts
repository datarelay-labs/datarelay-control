import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { buildRuntimeFlowTopology, snapshotIsFresh } from './runtime-flow-graph-model'

const NOW = Date.parse('2026-10-24T01:10:00Z')
function sample(): OperationalSnapshotResponse {
  return {
    updated_at: new Date(NOW - 12_000).toISOString(),
    global: {
      health_status: 'HEALTHY', total_streams: 1, enabled_streams: 1, running_streams: 1,
      error_streams: 0, total_routes: 2, enabled_routes: 2, total_destinations: 2,
      enabled_destinations: 2, total_eps_1m: 3, total_eps_5m: 3,
      avg_latency_ms: 10, last_activity_at: null,
    },
    streams: [{
      stream_id: 1, stream_name: 'Office365 Audit', source_id: 7, connector_id: 5,
      enabled: true, status: 'RUNNING', health_status: 'HEALTHY',
      eps_1m: 3, eps_5m: 3, success_rate_5m: 100, failure_rate_5m: 0,
      avg_latency_ms: 10, route_count: 2, healthy_route_count: 2, failed_route_count: 0,
      last_success_at: null, last_error_at: null, last_error_message: null,
      checkpoint_updated_at: null, checkpoint_lag_seconds: null,
    }],
    routes: [
      {
        route_id: 11, stream_id: 1, stream_name: 'Office365 Audit',
        destination_id: 21, destination_name: 'Syslog', destination_type: 'SYSLOG_UDP',
        enabled: true, failure_policy: 'retry', health_status: 'HEALTHY',
        delivered_eps_1m: 3, failed_eps_1m: 0, success_rate_5m: 100, retry_rate_5m: 0,
        avg_latency_ms: 10, last_success_at: null, last_error_at: null, last_error_message: null,
      },
      {
        route_id: 12, stream_id: 1, stream_name: 'Office365 Audit',
        destination_id: 22, destination_name: 'Archive', destination_type: 'HTTP',
        enabled: true, failure_policy: 'retry', health_status: 'HEALTHY',
        delivered_eps_1m: 0, failed_eps_1m: 0, success_rate_5m: 100, retry_rate_5m: 0,
        avg_latency_ms: 11, last_success_at: null, last_error_at: null, last_error_message: null,
      },
    ],
    destinations: [
      {
        destination_id: 21, destination_name: 'Syslog', destination_type: 'SYSLOG_UDP',
        enabled: true, health_status: 'HEALTHY', inbound_eps_1m: 3,
        failed_eps_1m: 0, avg_latency_ms: 10, route_count: 1,
        last_success_at: null, last_error_at: null, last_error_message: null,
      },
      {
        destination_id: 22, destination_name: 'Archive', destination_type: 'HTTP',
        enabled: true, health_status: 'HEALTHY', inbound_eps_1m: 0,
        failed_eps_1m: 0, avg_latency_ms: 11, route_count: 1,
        last_success_at: null, last_error_at: null, last_error_message: null,
      },
    ],
    problems: [],
  }
}
const delivery = (graph: ReturnType<typeof buildRuntimeFlowTopology>) =>
  graph.edges.filter((e) => e.data?.gatewayOnly)

describe('runtime data-flow topology projection', () => {
  it('does not invent a flow without an observed snapshot or Stream', () => {
    expect(buildRuntimeFlowTopology(null, 1, null, NOW).nodes).toEqual([])
    expect(buildRuntimeFlowTopology(sample(), 999, null, NOW).edges).toEqual([])
  })
  it('renders exact Source → Stream → Route → Destination identities and fanout', () => {
    const graph = buildRuntimeFlowTopology(sample(), 1, null, NOW)
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      'source:7', 'stream:1', 'route:11', 'route:12', 'destination:21', 'destination:22',
    ].sort())
    expect(graph.edges).toHaveLength(5)
    expect(graph.edges.map((e) => `${e.source}->${e.target}`)).toContain('route:11->destination:21')
    expect(graph.totalRoutes).toBe(2)
  })
  it('animates only fresh, enabled, positive gateway-reported delivery', () => {
    const rows = delivery(buildRuntimeFlowTopology(sample(), 1, null, NOW))
    expect(rows.map((r) => [r.data?.routeId, r.animated])).toEqual([[11, true], [12, false]])
    expect(rows[0]?.data?.evidence).toMatch(/receiver unverified/)
  })
  it('stops activity on stale, future or invalid snapshot timestamps', () => {
    const old = sample()
    old.updated_at = new Date(NOW - 91_000).toISOString()
    expect(delivery(buildRuntimeFlowTopology(old, 1, null, NOW)).every((r) => !r.animated)).toBe(true)
    expect(snapshotIsFresh(new Date(NOW + 1).toISOString(), NOW)).toBe(false)
    expect(snapshotIsFresh('not a timestamp', NOW)).toBe(false)
  })
  it('does not claim delivery when a Route, Destination or health is blocked', () => {
    const snapshot = sample()
    snapshot.routes[0]!.enabled = false
    expect(delivery(buildRuntimeFlowTopology(snapshot, 1, null, NOW))[0]?.animated).toBe(false)
    snapshot.routes[0]!.enabled = true
    snapshot.destinations[0]!.enabled = false
    expect(delivery(buildRuntimeFlowTopology(snapshot, 1, null, NOW))[0]?.animated).toBe(false)
    snapshot.destinations[0]!.enabled = true
    snapshot.routes[0]!.health_status = 'ERROR'
    expect(delivery(buildRuntimeFlowTopology(snapshot, 1, null, NOW))[0]?.animated).toBe(false)
  })
  it('shows missing Destination identity without inventing a verified receiver', () => {
    const snapshot = sample()
    snapshot.destinations = []
    const row = delivery(buildRuntimeFlowTopology(snapshot, 1, null, NOW))[0]!
    expect(row.animated).toBe(false)
    expect(row.data?.evidence).toContain('unavailable')
    expect(buildRuntimeFlowTopology(snapshot, 1, null, NOW).nodes
      .find((n) => n.id === 'destination:21')?.data.href).toBeNull()
  })
  it('omits invalid destination IDs and missing source relations', () => {
    const snapshot = sample()
    snapshot.streams[0]!.source_id = null
    snapshot.streams[0]!.connector_id = null
    snapshot.routes[0]!.destination_id = null
    const graph = buildRuntimeFlowTopology(snapshot, 1, null, NOW)
    expect(graph.nodes.some((n) => n.data.kind === 'source')).toBe(false)
    expect(delivery(graph)).toHaveLength(1)
    expect(graph.edges.some((e) => e.source === 'route:11' && e.target.startsWith('destination:'))).toBe(false)
  })
  it('caps large Route graphs but retains an inspected Route outside the default slice', () => {
    const snapshot = sample()
    snapshot.routes = Array.from({ length: 75 }, (_, index) => ({
      ...snapshot.routes[0]!, route_id: 100 + index,
    }))
    const graph = buildRuntimeFlowTopology(snapshot, 1, 174, NOW)
    expect(graph.shownRoutes).toBe(40)
    expect(graph.totalRoutes).toBe(75)
    expect(graph.nodes.some((n) => n.id === 'route:174')).toBe(true)
  })
  it('does not silently turn an observed zero into a moving edge', () => {
    const snapshot = sample()
    snapshot.routes[0]!.delivered_eps_1m = 0
    expect(delivery(buildRuntimeFlowTopology(snapshot, 1, null, NOW))[0]?.animated).toBe(false)
    snapshot.routes[0]!.delivered_eps_1m = NaN
    const row = delivery(buildRuntimeFlowTopology(snapshot, 1, null, NOW))[0]
    expect(row?.animated).toBe(false)
    expect(row?.data?.evidence).toBe('Delivery rate unavailable')
  })
})
