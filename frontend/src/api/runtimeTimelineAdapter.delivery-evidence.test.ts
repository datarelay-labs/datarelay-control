import { describe, expect, it } from 'vitest'
import { timelineItemsToRunHistoryRows } from './runtimeTimelineAdapter'
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
    expect(rows.map((row) => row.delivered)).toEqual([0, 0, 0])
    expect(rows.map((row) => row.failed)).toEqual([0, 0, 0])
  })

  it('counts actual route delivery outcomes and not unrelated source failures', () => {
    const rows = timelineItemsToRunHistoryRows([
      event(1, 'route_send_success'),
      event(2, 'route_retry_success'),
      event(3, 'route_send_failed', 'ERROR', 'FAILED'),
      event(4, 'route_retry_failed', 'ERROR', 'FAILED'),
      event(5, 'source_fetch', 'ERROR', 'FAILED'),
    ])
    expect(rows.map((row) => row.delivered)).toEqual([1, 1, 0, 0, 0])
    expect(rows.map((row) => row.failed)).toEqual([0, 0, 1, 1, 0])
  })
})
