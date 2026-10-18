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
  it('does not promote an unrecognized backend Run status into a false Success', () => {
    const metrics = {
      recent_runs: [{
        run_id: 'run-unknown',
        started_at: '2026-10-11T10:00:00Z',
        duration_ms: 0,
        status: 'SOMETHING_NEW',
        events: 0,
        delivered: 0,
        failed: 0,
      }],
    } as unknown as StreamRuntimeMetricsResponse
    const rows = runHistoryFromMetricsRecentRuns(metrics)
    expect(rows).toMatchObject([{ runId: 'run-unknown', status: 'Unknown' }])
  })

  it('preserves NO_EVENTS as a neutral no-event completion rather than partial failure', () => {
    const metrics = {
      recent_runs: [{
        run_id: 'run-777',
        started_at: '2026-10-11T10:00:00Z',
        duration_ms: 0,
        status: 'NO_EVENTS',
        events: 0,
        delivered: 0,
        failed: 0,
      }],
    } as unknown as StreamRuntimeMetricsResponse
    expect(runHistoryFromMetricsRecentRuns(metrics)).toMatchObject([{
      runId: 'run-777',
      status: 'No events',
      events: 0,
      delivered: 0,
      failed: 0,
      idBasis: 'completion-record',
    }])
  })

})
