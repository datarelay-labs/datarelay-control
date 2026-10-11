import { afterEach, describe, expect, it } from 'vitest'
import { timelineItemsToRunHistoryRows } from './runtimeTimelineAdapter'
import type { RuntimeTimelineItem } from './types/gdcApi'
import { setDisplayTimezoneCache } from '../lib/display-timezone-cache'

function event(id: number, stage: string, run_id: string | null, created_at = '2026-10-11T09:00:00Z'): RuntimeTimelineItem {
  return {
    id, stage, run_id, created_at,
    stream_id: 42, route_id: null, destination_id: null,
    level: stage === 'run_failed' ? 'ERROR' : 'INFO',
    status: stage === 'run_failed' ? 'FAILED' : 'COMPLETED',
    message: stage, error_code: null, retry_count: 0, http_status: null, latency_ms: null,
  }
}

afterEach(() => setDisplayTimezoneCache({ userTimezone: null, platformDefaultTimezone: null }))

describe('Stream Run History fallback source truth', () => {
  it('projects one actual run identity rather than treating every pipeline event as a separate Run', () => {
    setDisplayTimezoneCache({ userTimezone: 'UTC' })
    const run = 'run-20261011-first'
    const rows = timelineItemsToRunHistoryRows([
      event(1, 'source_fetch', run),
      event(2, 'run_started', run),
      event(3, 'route_send_success', run),
      event(4, 'checkpoint_update', run),
      event(5, 'run_complete', run, '2026-10-11T09:02:00Z'),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      runId: run,
      startedAt: '2026-10-11 09:00 UTC',
      status: 'Completed',
      countsVerified: false,
    })
    expect(rows[0]?.runId).not.toMatch(/^evt-/)
  })

  it('never manufactures a Run identity when the timeline lacks a real run_id', () => {
    expect(timelineItemsToRunHistoryRows([
      event(1, 'source_fetch', null),
      event(2, 'route_send_success', null),
      event(3, 'run_complete', null),
    ])).toEqual([])
  })

  it('shows a run as Started until an actual terminal event is recorded', () => {
    expect(timelineItemsToRunHistoryRows([
      event(1, 'run_started', 'run-only-start'),
      event(2, 'source_fetch', 'run-only-start'),
    ])).toMatchObject([{ runId: 'run-only-start', status: 'Started', countsVerified: false }])
  })

  it('does not invent a start timestamp from the completion event', () => {
    const rows = timelineItemsToRunHistoryRows([event(8, 'run_complete', 'run-no-start')])
    expect(rows).toMatchObject([{ runId: 'run-no-start', status: 'Completed', startedAt: '—', countsVerified: false }])
  })

  it('keeps the latest terminal result per real run, including observed failure', () => {
    const run = 'run-terminal-fail'
    expect(timelineItemsToRunHistoryRows([
      event(1, 'run_started', run),
      event(2, 'run_failed', run),
    ])).toMatchObject([{ runId: run, status: 'Failed', countsVerified: false }])
  })
})
