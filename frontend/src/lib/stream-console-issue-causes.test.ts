import { describe, expect, it } from 'vitest'
import type { StreamConsoleRow } from '../api/streamRows'
import {
  aggregateGroupIssueCauses,
  deriveStreamIssueCauses,
  formatIssuesDisplay,
  formatStreamIssuesCell,
  sortIssueCausesByPriority,
  streamOperationalHealthLabel,
} from './stream-console-issue-causes'
import { effectiveStreamSeverity } from './stream-operational-status'

function row(partial: Partial<StreamConsoleRow> & Pick<StreamConsoleRow, 'id' | 'name' | 'status'>): StreamConsoleRow {
  return {
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

describe('stream-console-issue-causes', () => {
  it('reports No Data when runtime snapshot is missing', () => {
    const causes = deriveStreamIssueCauses(
      row({ id: '1', name: 'A', status: 'RUNNING', hasRuntimeApiSnapshot: false, runtimeStatsAttempted: true }),
      '15m',
    )
    expect(causes).toContain('No Data (15m)')
  })

  it('reports Destination Error for ERROR status', () => {
    const causes = deriveStreamIssueCauses(row({ id: '2', name: 'B', status: 'ERROR', routesError: 1 }), '1h')
    expect(causes).toContain('Destination Error')
    expect(causes).not.toContain('No Data (1h)')
  })

  it('normalizes runtime issue details into canonical destination label', () => {
    const causes = deriveStreamIssueCauses(
      row({
        id: '2a',
        name: 'B-detail',
        status: 'DEGRADED',
        routesError: 0,
        runtimeIssue: 'Destination Error [Employee Name [route-a]]',
        deliveryPct: 100,
        deliveryPctKnown: true,
      }),
      '1h',
    )
    expect(causes).toContain('Destination Error')
    expect(causes).not.toContain('Destination Error [Employee Name [route-a]]')
    expect(formatStreamIssuesCell(
      row({
        id: '2a',
        name: 'B-detail',
        status: 'DEGRADED',
        routesError: 0,
        runtimeIssue: 'Destination Error [Employee Name [route-a]]',
        deliveryPct: 100,
        deliveryPctKnown: true,
      }),
      '1h',
    )).toBe('Destination Error')
  })

  it('does not report destination issues for idle routes with strong success rate', () => {
    const causes = deriveStreamIssueCauses(
      row({
        id: '6',
        name: 'CyberHeaven',
        status: 'RUNNING',
        routesTotal: 2,
        routesOk: 0,
        routesDegraded: 2,
        routesError: 0,
        deliveryPct: 100,
        deliveryPctKnown: true,
        runtimeIssue: 'Stream delivery degraded',
      }),
      '1h',
    )
    expect(causes).not.toContain('Destination Error')
    expect(causes).not.toContain('Stream delivery degraded')
    expect(formatStreamIssuesCell(
      row({
        id: '6',
        name: 'CyberHeaven',
        status: 'RUNNING',
        routesTotal: 2,
        routesOk: 0,
        routesDegraded: 2,
        routesError: 0,
        deliveryPct: 100,
        deliveryPctKnown: true,
        runtimeIssue: 'Stream delivery degraded',
      }),
      '1h',
    )).toBe('—')
  })

  it('reports Checkpoint Error from recent delivery logs', () => {
    const causes = deriveStreamIssueCauses(
      row({
        id: '3',
        name: 'C',
        status: 'DEGRADED',
        recentErrors: [{ message: 'checkpoint_update failed', relativeAt: '1m ago' }],
      }),
      '1h',
    )
    expect(causes).toContain('Checkpoint Error')
  })

  it('treats "behind delivery" lag label (>= 1h, from snapshot) as Checkpoint Error', () => {
    // checkpointLagLabel is only set to "behind delivery · Ns" when lag >= 3600s
    // (enforced in enrichStreamRowFromOperationalSnapshot). At that threshold it IS an
    // actionable error.
    const causes = deriveStreamIssueCauses(
      row({
        id: '3d',
        name: 'stale-behind',
        status: 'RUNNING',
        deliveryPct: 100,
        deliveryPctKnown: true,
        checkpointLagLabel: 'behind delivery · 3700s',
      }),
      '1h',
    )
    expect(causes).toContain('Checkpoint Error')
  })

  it('does not treat stale checkpoint lag metadata as Checkpoint Error', () => {
    const causes = deriveStreamIssueCauses(
      row({
        id: '3b',
        name: 'stale-lag',
        status: 'RUNNING',
        deliveryPct: 100,
        deliveryPctKnown: true,
        runtimeIssue: 'Checkpoint lag: 86400s',
        checkpointLagLabel: '—',
      }),
      '1h',
    )
    expect(causes).not.toContain('Checkpoint Error')
    expect(formatStreamIssuesCell(
      row({
        id: '3b',
        name: 'stale-lag',
        status: 'RUNNING',
        deliveryPct: 100,
        deliveryPctKnown: true,
        runtimeIssue: 'Checkpoint lag: 86400s',
      }),
      '1h',
    )).toBe('—')
  })

  it('does not mark destination error from checkpoint-only degradation', () => {
    const causes = deriveStreamIssueCauses(
      row({
        id: '3a',
        name: 'checkpoint-only',
        status: 'DEGRADED',
        events1h: 0,
        eps1m: 0,
        deliveryPctKnown: true,
        deliveryPct: 0,
        runtimeIssue: 'Checkpoint lag exceeded threshold',
        checkpointLagLabel: 'lag 420s',
        recentErrors: [{ message: 'checkpoint update stalled', relativeAt: '1m ago' }],
      }),
      '1h',
    )
    expect(causes).toContain('Checkpoint Error')
    expect(causes).not.toContain('Destination Error')
  })

  it('sorts causes by operator priority (Protection before Destination)', () => {
    const sorted = sortIssueCausesByPriority([
      'Schema Drift',
      'Destination Error',
      'Protection Block',
      'No Data (1h)',
    ])
    expect(sorted).toEqual(['Protection Block', 'Destination Error', 'No Data (1h)', 'Schema Drift'])
  })

  it('limits issues display to two causes with +N suffix', () => {
    expect(
      formatIssuesDisplay([
        'Schema Drift',
        'Destination Error',
        'Protection Block',
        'No Data (1h)',
      ]),
    ).toBe('Protection Block · Destination Error +2')
  })

  it('aggregates unique group causes with limited label', () => {
    const a = row({ id: '1', name: 'A', status: 'ERROR', routesError: 1 })
    const b = row({
      id: '2',
      name: 'B',
      status: 'DEGRADED',
      recentErrors: [{ message: 'schema drift detected', relativeAt: '1m ago' }],
    })
    const agg = aggregateGroupIssueCauses([a, b], '24h')
    expect(agg.streamCount).toBe(2)
    expect(agg.label).toMatch(/Destination Error/)
    expect(agg.hiddenCount).toBeGreaterThanOrEqual(0)
  })

  it('formats stream issues cell with cause labels', () => {
    expect(formatStreamIssuesCell(row({ id: '4', name: 'D', status: 'RUNNING' }), '1h')).toBe('—')
    expect(
      formatStreamIssuesCell(row({ id: '5', name: 'E', status: 'ERROR', routesError: 2 }), '1h'),
    ).toBe('Destination Error')
  })

  it('maps operational health labels from severity', () => {
    expect(streamOperationalHealthLabel(effectiveStreamSeverity(row({ id: '6', name: 'F', status: 'RUNNING' })))).toBe(
      'Healthy',
    )
    expect(streamOperationalHealthLabel(effectiveStreamSeverity(row({ id: '7', name: 'G', status: 'DEGRADED', deliveryPct: 80, deliveryPctKnown: true })))).toBe(
      'Warning',
    )
  })
})

describe('streamConsoleLifecycleLabel', () => {
  const base = {
    id: '1',
    name: 's',
    connectorId: null,
    connectorName: '—',
    sourceTypeLabel: '—',
    runtimeStatsAttempted: true,
    hasRuntimeApiSnapshot: true,
    events1h: 0,
    events24h: 0,
    ingestEps: 0,
    eps1m: 0,
    eps5m: 0,
    successRate5m: null,
    runtimeIssue: null,
    eventsTrend: [0, 0, 0, 0, 0, 0, 0] as const,
    lastCheckpointDisplay: '—',
    lastCheckpointRelative: '—',
    routesTotal: 0,
    routesOk: 0,
    routesDegraded: 0,
    routesError: 0,
    deliveryPct: 0,
    deliveryPctKnown: false,
    latencyP95Ms: 0,
    latencyTrend: [0, 0, 0, 0, 0, 0, 0] as const,
    lastActivityRelative: '—',
    streamType: 'HTTP',
    streamTypeKey: 'HTTP_API_POLLING',
    pollingIntervalSec: 60,
    createdAt: '—',
    createdBy: '—',
    sourceMethod: 'GET' as const,
    sourceUrl: '—',
    authType: '—',
    timeoutSec: 30,
    rateLimitLabel: '—',
    checkpointValue: '—',
    checkpointUpdatedAt: '—',
    checkpointLagLabel: '—',
    recentErrors: [],
  }

  it('maps status matrix for Stopped / Disabled / No Data / Healthy', async () => {
    const { streamConsoleLifecycleLabel } = await import('./stream-console-issue-causes')
    expect(streamConsoleLifecycleLabel({ ...base, status: 'RUNNING', enabled: true })).toBe('Healthy')
    expect(streamConsoleLifecycleLabel({ ...base, status: 'IDLE', enabled: true })).toBe('No Data')
    expect(streamConsoleLifecycleLabel({ ...base, status: 'STOPPED', enabled: false })).toBe('Stopped')
    expect(streamConsoleLifecycleLabel({ ...base, status: 'RUNNING', enabled: false })).toBe('Disabled')
    expect(streamConsoleLifecycleLabel({ ...base, status: 'ERROR', enabled: true })).toBe('Critical')
  })
})
