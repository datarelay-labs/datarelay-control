import { describe, expect, it } from 'vitest'
import { buildRetryTimelineEntries, retryTimelineSummary } from './logs-console-helpers'
import type { LogExplorerRow } from './logs-types'

function row(contextJson: Record<string, unknown>): LogExplorerRow {
  return {
    id: '1',
    eventId: 'evt_1',
    timeIso: '2026-10-31T17:40:00Z',
    level: 'ERROR',
    connector: 'c',
    stream: 's',
    route: 'r',
    message: 'm',
    durationMs: 0,
    contextJson,
    relatedEventId: null,
  }
}

// F-168: the Retry Timeline used to be synthesized from retry_count with invented 1500 ms * 2^n
// backoff and "No retries recorded" for rows that did retry.
describe('retry timeline shows only recorded evidence (F-168)', () => {
  const failed = row({
    stage: 'route_retry_failed',
    retry_count: 2,
    payload_sample: {
      max_retries: 5,
      retry_backoff: 'exponential',
      give_up_reason: 'non_retryable_error',
      retry_attempts: [
        { attempt: 1, delay_before_sec: 1, started_at: '2026-10-31T17:38:01Z', outcome: 'failed', http_status: 500, message: 'boom' },
        { attempt: 2, delay_before_sec: 2, started_at: '2026-10-31T17:38:04Z', outcome: 'failed', http_status: 401 },
      ],
    },
  })

  it('lists the persisted attempts with their real delay and error', () => {
    const entries = buildRetryTimelineEntries(failed)
    expect(entries.map((e) => e.attempt)).toEqual([1, 2])
    expect(entries[0].backoffLabel).toBe('1 s wait before this attempt')
    expect(entries[0].detail).toBe('HTTP 500 · boom')
    expect(entries[1].backoffLabel).toBe('2 s wait before this attempt')
    expect(entries[1].detail).toBe('HTTP 401')
    expect(entries[0].atLabel).toContain('2026-10-31 17:38:01')
  })

  it('summarizes attempts against the configured maximum and the give-up reason', () => {
    expect(retryTimelineSummary(failed)).toEqual({
      attempts: 2,
      maxRetries: 5,
      backoff: 'exponential',
      giveUpReason: 'The error cannot be fixed by retrying (for example HTTP 401/403)',
    })
  })

  it('never invents attempts for a row without persisted retry steps', () => {
    const legacy = row({ stage: 'route_retry_failed', retry_count: 3 })
    expect(buildRetryTimelineEntries(legacy)).toEqual([])
    expect(retryTimelineSummary(legacy)).toMatchObject({ attempts: 3, maxRetries: null, giveUpReason: null })
  })

  it('has no summary for a row that was never retried', () => {
    expect(retryTimelineSummary(row({ stage: 'route_send_success', retry_count: 0 }))).toBeNull()
  })
})
