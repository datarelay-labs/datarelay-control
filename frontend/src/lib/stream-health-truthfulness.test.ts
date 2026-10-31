import { describe, expect, it } from 'vitest'
import type { StreamConsoleRow } from '../api/streamRows'
import { enrichStreamRowFromOperationalSnapshot } from '../api/streamRows'
import type { OperationalProblem, OperationalStreamSnapshot } from '../api/operationalSnapshot'
import { computeStreamOperationsSummary, streamOperationalSeverity } from './streams-console-operations'
import { deriveStreamIssueCauses, streamConsoleLifecycleLabel } from './stream-console-issue-causes'

function row(partial: Partial<StreamConsoleRow> & Pick<StreamConsoleRow, 'id' | 'name' | 'status'>): StreamConsoleRow {
  return {
    connectorId: 10,
    connectorName: 'Office365 Connector',
    connectorProductGroup: 'Office365',
    sourceTypeLabel: 'API',
    runtimeStatsAttempted: true,
    hasRuntimeApiSnapshot: true,
    events1h: 100,
    events24h: 0,
    ingestEps: 0,
    eps1m: null,
    eps5m: null,
    successRate5m: null,
    runtimeIssue: null,
    eventsTrend: [1, 2, 3],
    lastCheckpointDisplay: '—',
    lastCheckpointRelative: '—',
    routesTotal: 1,
    routesOk: 1,
    routesDegraded: 0,
    routesError: 0,
    deliveryPct: 100,
    deliveryPctKnown: true,
    latencyP95Ms: 10,
    latencyTrend: [1],
    lastActivityRelative: '1m ago',
    streamType: 'HTTP',
    streamTypeKey: 'HTTP_API_POLLING',
    pollingIntervalSec: 60,
    createdAt: '',
    createdBy: '',
    sourceMethod: 'GET',
    sourceUrl: '',
    authType: '',
    timeoutSec: 30,
    rateLimitLabel: '—',
    checkpointValue: '',
    checkpointUpdatedAt: '',
    checkpointLagLabel: '—',
    recentErrors: [],
    ...partial,
  }
}

function snapshot(partial: Partial<OperationalStreamSnapshot> = {}): OperationalStreamSnapshot {
  return {
    stream_id: 10,
    stream_name: 'bfs-stream-bearer-s10',
    connector_id: 4,
    source_id: 1,
    enabled: true,
    status: 'RUNNING',
    health_status: 'HEALTHY',
    eps_1m: 0,
    eps_5m: 0,
    success_rate_5m: null,
    failure_rate_5m: null,
    avg_latency_ms: null,
    route_count: 1,
    healthy_route_count: 1,
    failed_route_count: 0,
    last_success_at: '2026-10-31T17:30:00Z',
    last_error_at: null,
    last_error_message: null,
    checkpoint_updated_at: null,
    checkpoint_lag_seconds: null,
    ...partial,
  }
}

function sourceProblem(httpStatus: number, code = 'SOURCE_AUTH_FAILED'): OperationalProblem {
  return {
    severity: 'critical',
    scope: 'stream',
    stream_id: 10,
    route_id: null,
    destination_id: null,
    title: `Stream bfs-stream-bearer-s10: source authentication failed (HTTP ${httpStatus})`,
    message: `The latest source request through Connector bfs-http-bearer failed with HTTP ${httpStatus}.`,
    last_seen_at: '2026-10-31T17:33:00Z',
    error_code: code,
    http_status: httpStatus,
    connector_id: 4,
    connector_name: 'bfs-http-bearer',
  }
}

const base = row({ id: '10', name: 'bfs-stream-bearer-s10', status: 'RUNNING' })

describe('Streams page health uses the same evidence as the Dashboard (F-166, F-163)', () => {
  it.each([401, 429, 500])('a Source HTTP %i problem makes the stream Critical, not Healthy', (httpStatus) => {
    const code = httpStatus === 401 ? 'SOURCE_AUTH_FAILED' : 'SOURCE_FETCH_FAILED'
    const enriched = enrichStreamRowFromOperationalSnapshot(base, snapshot(), [sourceProblem(httpStatus, code)])
    expect(streamOperationalSeverity(enriched)).toBe('critical')
    expect(streamConsoleLifecycleLabel(enriched)).toBe('Critical')
    expect(enriched.sourceFailure).toEqual({ code, httpStatus, connectorName: 'bfs-http-bearer' })
    expect(deriveStreamIssueCauses(enriched, '1h')).toContain('Source Error')
    const summary = computeStreamOperationsSummary([enriched])
    expect(summary).toMatchObject({ healthy: 0, critical: 1, issues: 1 })
  })

  it('a snapshot health verdict of DEGRADED is a Warning on the Streams page', () => {
    const enriched = enrichStreamRowFromOperationalSnapshot(
      base,
      snapshot({ health_status: 'DEGRADED', last_error_message: 'no recent ingest/delivery observed' }),
      [],
    )
    expect(streamOperationalSeverity(enriched)).toBe('warning')
    expect(streamConsoleLifecycleLabel(enriched)).toBe('Warning')
  })

  it('a snapshot health verdict of ERROR is Critical on the Streams page', () => {
    const enriched = enrichStreamRowFromOperationalSnapshot(base, snapshot({ health_status: 'ERROR' }), [])
    expect(streamOperationalSeverity(enriched)).toBe('critical')
  })

  it('a stream without problems and with a HEALTHY verdict stays Healthy', () => {
    const enriched = enrichStreamRowFromOperationalSnapshot(
      base,
      snapshot({ eps_1m: 1, eps_5m: 1, success_rate_5m: 100, failure_rate_5m: 0 }),
      [],
    )
    expect(streamOperationalSeverity(enriched)).toBe('healthy')
    expect(enriched.sourceFailure).toBeNull()
  })

  it('a stream with zero traffic and no verdict stays Not verified (no evidence is not Healthy)', () => {
    const enriched = enrichStreamRowFromOperationalSnapshot(
      base,
      snapshot({ health_status: 'IDLE', last_success_at: null }),
      [],
    )
    expect(streamOperationalSeverity(enriched)).toBe('unknown')
  })

  it('problems of another stream do not affect this stream', () => {
    const other = { ...sourceProblem(401), stream_id: 99 }
    const enriched = enrichStreamRowFromOperationalSnapshot(base, snapshot(), [other])
    expect(enriched.operationalProblemSeverity).toBeNull()
  })
})
