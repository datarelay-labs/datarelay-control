import { describe, expect, it } from 'vitest'
import type { LogExplorerRow } from '../components/logs/logs-types'
import { logsOverviewCounts } from './logsOverviewAdapter'
import type { OperationalStreamSnapshot } from './operationalSnapshot'
import {
  buildRuntimeDetailNumericOverlay,
  formatRouteHealthDestination,
  formatRouteHealthTypeLabel,
  mergeStreamHealthSignals,
  routeHealthRowsFromApi,
} from './runtimeHealthAdapter'
import { enrichStreamRowFromOperationalSnapshot, mapBackendStreamStatus, streamReadToConsoleRow } from './streamRows'
import { timelineItemsToRecentLogLines, timelineItemsToRunHistoryRows } from './runtimeTimelineAdapter'
import type { RouteHealthItem, StreamHealthResponse, StreamRuntimeMetricsResponse, StreamRuntimeStatsResponse } from './types/gdcApi'

function routeFixture(overrides: Partial<RouteHealthItem> = {}): RouteHealthItem {
  return {
    route_id: 2,
    destination_id: 40,
    destination_type: 'WEBHOOK',
    route_enabled: true,
    destination_enabled: true,
    failure_policy: 'retry',
    route_status: 'ENABLED',
    health: 'HEALTHY',
    success_count: 8,
    failure_count: 2,
    rate_limited_count: 0,
    consecutive_failure_count: 0,
    ...overrides,
  }
}

describe('mapBackendStreamStatus', () => {
  it('maps null/blank to UNKNOWN', () => {
    expect(mapBackendStreamStatus(null)).toBe('UNKNOWN')
    expect(mapBackendStreamStatus(undefined)).toBe('UNKNOWN')
    expect(mapBackendStreamStatus('   ')).toBe('UNKNOWN')
  })

  it('maps known backend literals', () => {
    expect(mapBackendStreamStatus('RUNNING')).toBe('RUNNING')
    expect(mapBackendStreamStatus('ERROR')).toBe('ERROR')
    expect(mapBackendStreamStatus('RATE_LIMITED_SOURCE')).toBe('DEGRADED')
    expect(mapBackendStreamStatus('PAUSED')).toBe('STOPPED')
    expect(mapBackendStreamStatus('STOPPED')).toBe('STOPPED')
    expect(mapBackendStreamStatus('IDLE')).toBe('IDLE')
  })

  it('maps unrecognized strings to UNKNOWN', () => {
    expect(mapBackendStreamStatus('MY_NEW_STATE')).toBe('UNKNOWN')
  })
})

describe('logsOverviewCounts', () => {
  it('returns zeros for null/undefined input', () => {
    expect(logsOverviewCounts(null)).toEqual({ total: 0, errors: 0, warnings: 0, info: 0, debug: 0 })
    expect(logsOverviewCounts(undefined)).toEqual({ total: 0, errors: 0, warnings: 0, info: 0, debug: 0 })
  })

  it('counts levels', () => {
    const rows: LogExplorerRow[] = [
      {
        id: '1',
        eventId: 'e1',
        timeIso: '2026-01-01T00:00:00Z',
        level: 'ERROR',
        connector: '—',
        stream: '—',
        route: '—',
        message: 'x',
        durationMs: 0,
        contextJson: {},
        relatedEventId: null,
      },
      {
        id: '2',
        eventId: 'e2',
        timeIso: '2026-01-01T00:00:01Z',
        level: 'WARN',
        connector: '—',
        stream: '—',
        route: '—',
        message: 'y',
        durationMs: 0,
        contextJson: {},
        relatedEventId: null,
      },
      {
        id: '3',
        eventId: 'e3',
        timeIso: '2026-01-01T00:00:02Z',
        level: 'INFO',
        connector: '—',
        stream: '—',
        route: '—',
        message: 'z',
        durationMs: 0,
        contextJson: {},
        relatedEventId: null,
      },
    ]
    expect(logsOverviewCounts(rows)).toEqual({ total: 3, errors: 1, warnings: 1, info: 1, debug: 0 })
  })
})

describe('runtimeHealthAdapter labels', () => {
  it('formats destination line readably', () => {
    expect(formatRouteHealthDestination({ route_id: 5, destination_id: 12 })).toBe('Destination #12 · Route #5')
    expect(formatRouteHealthDestination({ route_id: 5, destination_id: 12, destination_name: 'Main Syslog' })).toBe(
      'Main Syslog · Route #5',
    )
  })

  it('notes disabled routes in type label', () => {
    expect(
      formatRouteHealthTypeLabel({
        destination_type: 'WEBHOOK',
        route_enabled: false,
        destination_enabled: true,
      }),
    ).toContain('off')
  })
})

describe('routeHealthRowsFromApi', () => {
  it('returns null without routes', () => {
    expect(routeHealthRowsFromApi(null)).toBeNull()
    expect(
      routeHealthRowsFromApi({
        stream_id: 1,
        stream_status: 'RUNNING',
        health: 'HEALTHY',
        limit: 50,
        summary: {
          total_routes: 0,
          healthy_routes: 0,
          degraded_routes: 0,
          unhealthy_routes: 0,
          disabled_routes: 0,
          idle_routes: 0,
        },
        routes: [],
      }),
    ).toBeNull()
  })

  it('avoids NaN delivery pct when counts are zero', () => {
    const health: StreamHealthResponse = {
      stream_id: 1,
      stream_status: 'RUNNING',
      health: 'DEGRADED',
      limit: 80,
      summary: {
        total_routes: 1,
        healthy_routes: 0,
        degraded_routes: 1,
        unhealthy_routes: 0,
        disabled_routes: 0,
        idle_routes: 0,
      },
      routes: [routeFixture({ success_count: 0, failure_count: 0, health: 'IDLE' })],
    }
    const rows = routeHealthRowsFromApi(health)
    expect(rows).not.toBeNull()
    expect(rows![0]!.deliveryPct).toBe(0)
    expect(Number.isFinite(rows![0]!.deliveryPct)).toBe(true)
    expect(rows![0]!.status).toBe('Degraded')
  })

  it('maps unknown health to Unknown', () => {
    const health: StreamHealthResponse = {
      stream_id: 1,
      stream_status: 'RUNNING',
      health: 'DEGRADED',
      limit: 80,
      summary: {
        total_routes: 1,
        healthy_routes: 0,
        degraded_routes: 0,
        unhealthy_routes: 0,
        disabled_routes: 0,
        idle_routes: 0,
      },
      routes: [routeFixture({ health: 'SOMETHING_NEW' as never })],
    }
    const rows = routeHealthRowsFromApi(health)
    expect(rows?.[0]?.status).toBe('Unknown')
  })
})

describe('mergeStreamHealthSignals', () => {
  it('keeps finite error rate and stable labels with empty attempts', () => {
    const base = [
      { label: 'Error Rate (1h)', value: 'x', tone: 'neutral' as const },
      { label: 'Successive Failures', value: '0', tone: 'neutral' as const },
      { label: 'Polling', value: 'x', tone: 'neutral' as const },
    ]
    const stats: StreamRuntimeStatsResponse = {
      stream_id: 1,
      stream_status: 'RUNNING',
      checkpoint: null,
      summary: {
        total_logs: 0,
        route_send_success: 0,
        route_send_failed: 0,
        route_retry_success: 0,
        route_retry_failed: 0,
        route_skip: 0,
        source_rate_limited: 0,
        destination_rate_limited: 0,
        route_unknown_failure_policy: 0,
        run_complete: 0,
      },
      last_seen: { success_at: null, failure_at: null, rate_limited_at: null },
      routes: [],
      recent_logs: [],
    }
    const health: StreamHealthResponse = {
      stream_id: 1,
      stream_status: 'RUNNING',
      health: 'HEALTHY',
      limit: 50,
      summary: {
        total_routes: 1,
        healthy_routes: 1,
        degraded_routes: 0,
        unhealthy_routes: 0,
        disabled_routes: 0,
        idle_routes: 0,
      },
      routes: [routeFixture({ consecutive_failure_count: 0 })],
    }
    const merged = mergeStreamHealthSignals(base, stats, health)
    expect(merged[0]?.value).toBe('0.00%')
    expect(merged[0]?.tone).toBe('ok')
    expect(merged[1]?.value).toBe('0')
    expect(merged[2]?.detail).toContain('runtime API data')
  })

  it('derives error rate from delivery outcomes for metrics branch', () => {
    const base = [{ label: 'Error Rate (1h)', value: 'x', tone: 'neutral' as const }]
    const metrics = {
      stream: { id: 1, name: 'S', status: 'RUNNING', last_run_at: null, last_success_at: null, last_error_at: null, last_checkpoint: null },
      kpis: {
        events_last_hour: 120,
        delivered_last_hour: 60,
        failed_last_hour: 20,
        // Intentionally inconsistent with delivered/failed; UI should ignore this
        // field to keep all cards/charts on the same denominator.
        delivery_success_rate: 99,
        avg_latency_ms: 0,
        max_latency_ms: 0,
        error_rate: 1,
      },
      events_over_time: [],
      route_health: [],
      checkpoint_history: [],
      recent_runs: [],
      route_runtime: [],
      recent_route_errors: [],
    } satisfies StreamRuntimeMetricsResponse
    const merged = mergeStreamHealthSignals(base, null, null, metrics)
    expect(merged[0]?.value).toBe('25.00%')
    expect(merged[0]?.detail).toBe('20 failed / 80 attempts')
    expect(merged[0]?.tone).toBe('err')
  })
})

describe('buildRuntimeDetailNumericOverlay', () => {
  it('leaves delivery null when no send attempts', () => {
    const stats: StreamRuntimeStatsResponse = {
      stream_id: 1,
      stream_status: 'RUNNING',
      checkpoint: null,
      summary: {
        total_logs: 120,
        processed_events: 7200,
        route_send_success: 0,
        route_send_failed: 0,
        route_retry_success: 0,
        route_retry_failed: 0,
        route_skip: 0,
        source_rate_limited: 0,
        destination_rate_limited: 0,
        route_unknown_failure_policy: 0,
        run_complete: 0,
      },
      last_seen: { success_at: null, failure_at: null, rate_limited_at: null },
      routes: [],
      recent_logs: [],
    }
    const o = buildRuntimeDetailNumericOverlay(stats, null)
    expect(o.deliveryPct).toBeNull()
    expect(o.events1h).toBe(7200)
    expect(o.eventsPerMinApprox).toBe(120)
  })

  it('falls back to total_logs when processed_events is absent', () => {
    const stats: StreamRuntimeStatsResponse = {
      stream_id: 1,
      stream_status: 'RUNNING',
      checkpoint: null,
      summary: {
        total_logs: 0,
        route_send_success: 0,
        route_send_failed: 0,
        route_retry_success: 0,
        route_retry_failed: 0,
        route_skip: 0,
        source_rate_limited: 0,
        destination_rate_limited: 0,
        route_unknown_failure_policy: 0,
        run_complete: 0,
      },
      last_seen: { success_at: null, failure_at: null, rate_limited_at: null },
      routes: [],
      recent_logs: [],
    }
    const o = buildRuntimeDetailNumericOverlay(stats, null)
    expect(o.events1h).toBe(0)
  })
})

describe('runtimeTimelineAdapter', () => {
  it('returns empty arrays for null/undefined items', () => {
    expect(timelineItemsToRunHistoryRows(null)).toEqual([])
    expect(timelineItemsToRecentLogLines(undefined)).toEqual([])
  })

  it('guards missing timestamps and latency', () => {
    const rows = timelineItemsToRunHistoryRows([
      {
        id: 1,
        created_at: '',
        stream_id: null,
        route_id: null,
        destination_id: null,
        stage: 'route_send',
        level: 'INFO',
        status: null,
        message: 'ok',
        error_code: null,
        retry_count: 0,
        http_status: null,
        latency_ms: Number.NaN,
      },
    ])
    expect(rows[0]!.startedAt).toBe('—')
    expect(rows[0]!.duration).toBe('—')
  })
})

describe('enrichStreamRowFromOperationalSnapshot – checkpoint lag threshold', () => {
  function snapshotFixture(overrides: Partial<OperationalStreamSnapshot> = {}): OperationalStreamSnapshot {
    return {
      stream_id: 1,
      stream_name: 'Test Stream',
      connector_id: null,
      source_id: null,
      enabled: true,
      status: 'RUNNING',
      health_status: 'HEALTHY',
      eps_1m: 1.0,
      eps_5m: 1.0,
      success_rate_5m: 100,
      failure_rate_5m: 0,
      avg_latency_ms: null,
      route_count: 1,
      healthy_route_count: 1,
      failed_route_count: 0,
      last_success_at: '2026-06-26T12:00:00',
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
      ...overrides,
    }
  }

  const baseRow = streamReadToConsoleRow({
    id: 1,
    name: 'Test Stream',
    status: 'RUNNING',
    source_type: 'HTTP_API_POLLING',
    stream_type: null,
    source_id: null,
    connector_id: null,
    polling_interval: 60,
    created_at: '2026-01-01T00:00:00',
    config_json: {},
  })

  it('does not set "behind delivery" for lag < 3600s', () => {
    const row = enrichStreamRowFromOperationalSnapshot(
      baseRow,
      snapshotFixture({
        eps_1m: 1.0,
        checkpoint_lag_seconds: 120,
        checkpoint_updated_at: '2026-06-26T11:58:00.000Z',
        last_success_at: '2026-06-26T12:00:00.000Z',
      }),
    )
    expect(row.checkpointLagLabel).not.toMatch(/behind/)
  })

  it('does not set "behind delivery" for idle streams (eps=0) even with large lag', () => {
    // Mirrors backend: idle streams are excluded from stale-checkpoint flagging
    const row = enrichStreamRowFromOperationalSnapshot(
      baseRow,
      snapshotFixture({
        eps_1m: 0,
        eps_5m: 0,
        checkpoint_lag_seconds: 3700,
        checkpoint_updated_at: '2026-06-26T11:00:00.000Z',
        last_success_at: '2026-06-26T12:00:00.000Z',
      }),
    )
    expect(row.checkpointLagLabel).not.toMatch(/behind/)
  })

  it('does not set "behind delivery" when millisecond-delta is transactional noise (eps=0)', () => {
    // Checkpoint written ~10ms before success — normal transactional ordering, not an error
    const row = enrichStreamRowFromOperationalSnapshot(
      baseRow,
      snapshotFixture({
        eps_1m: 0,
        eps_5m: 0,
        checkpoint_lag_seconds: 3700,
        checkpoint_updated_at: '2026-06-26T11:00:00.010Z',
        last_success_at: '2026-06-26T11:00:00.020Z',
      }),
    )
    expect(row.checkpointLagLabel).not.toMatch(/behind/)
  })

  it('sets "behind delivery" label for active stream with lag >= 3600s and meaningful cp delta', () => {
    const row = enrichStreamRowFromOperationalSnapshot(
      baseRow,
      snapshotFixture({
        eps_1m: 1.5,
        checkpoint_lag_seconds: 3700,
        checkpoint_updated_at: '2026-06-26T11:00:00.000Z',
        last_success_at: '2026-06-26T12:00:00.000Z',  // 1h gap
      }),
    )
    expect(row.checkpointLagLabel).toMatch(/behind delivery/)
  })

  it('does not set "behind delivery" when checkpoint is newer than last delivery', () => {
    const row = enrichStreamRowFromOperationalSnapshot(
      baseRow,
      snapshotFixture({
        eps_1m: 1.0,
        checkpoint_lag_seconds: 3700,
        checkpoint_updated_at: '2026-06-26T12:01:00.000Z',
        last_success_at: '2026-06-26T11:00:00.000Z',
      }),
    )
    expect(row.checkpointLagLabel).not.toMatch(/behind/)
  })
})
