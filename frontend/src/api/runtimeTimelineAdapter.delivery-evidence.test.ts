import { describe, expect, it } from 'vitest'
import { timelineItemsToRecentLogLines, timelineItemsToRunHistoryRows } from './runtimeTimelineAdapter'
import type { RuntimeTimelineItem } from './types/gdcApi'

function event(id: number, stage: string, level = 'INFO', status = 'SUCCESS'): RuntimeTimelineItem {
  return {
    id,
    created_at: '2026-10-10T09:00:00Z',
    stream_id: 42,
    route_id: 7,
    destination_id: 10,
    run_id: 'run-evidence',
    stage,
    level,
    status,
    message: stage,
    error_code: null,
    retry_count: 0,
    http_status: null,
    latency_ms: null,
  }
}

describe('Stream runtime timeline delivery evidence', () => {
  it('does not invent delivery success for ordinary INFO lifecycle, checkpoint or source events', () => {
    const rows = timelineItemsToRunHistoryRows([
      event(1, 'source_fetch'),
      event(2, 'run_complete'),
      event(3, 'checkpoint_update'),
    ])
    // A lifecycle completion is a real run record, but cannot prove any delivery volume.
    expect(rows).toMatchObject([{
      runId: 'run-evidence',
      status: 'Completed',
      countsVerified: false,
      delivered: 0,
      failed: 0,
    }])
  })

  it('preserves recorded Route delivery outcomes in scoped recent logs, not synthetic Run totals', () => {
    const events = [
      event(1, 'route_send_success'),
      event(2, 'route_retry_success'),
      event(3, 'route_send_failed', 'ERROR', 'FAILED'),
      event(4, 'route_retry_failed', 'ERROR', 'FAILED'),
      event(5, 'source_fetch', 'ERROR', 'FAILED'),
    ]
    // An individual delivery event does not establish that a run completed or how many events it processed.
    expect(timelineItemsToRunHistoryRows(events)).toEqual([])
    const logs = timelineItemsToRecentLogLines(events)
    expect(logs.map((row) => row.stage)).toEqual([
      'source_fetch', 'route_retry_failed', 'route_send_failed', 'route_retry_success', 'route_send_success',
    ])
    expect(logs.filter((row) => row.level === 'ERROR').map((row) => row.stage)).toEqual([
      'source_fetch', 'route_retry_failed', 'route_send_failed',
    ])
  })
})
