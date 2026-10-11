import { describe, expect, it } from 'vitest'
import { runHistoryFromMetricsRecentRuns } from './runtimeMetricsAdapter'
import type { StreamRuntimeMetricsResponse } from './types/gdcApi'

describe('Metrics Run History completion evidence', () => {
  it('marks a backend-generated run-log label as a completion record, not a verified run_id', () => {
    const metrics = {
      recent_runs: [{
        run_id: 'run-123',
        started_at: '2026-10-11T12:00:00Z',
        duration_ms: 0,
        status: 'SUCCESS',
        events: 8,
        delivered: 7,
        failed: 1,
      }],
    } as unknown as StreamRuntimeMetricsResponse
    const rows = runHistoryFromMetricsRecentRuns(metrics)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      runId: 'run-123',
      idBasis: 'completion-record',
      status: 'Success',
      events: 8,
      delivered: 7,
      failed: 1,
    })
  })
})
