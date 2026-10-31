import { describe, expect, it } from 'vitest'
import { enrichStreamRowWithRuntime, formatCheckpointValueForConsole, streamReadToConsoleRow } from './streamRows'

describe('formatCheckpointValueForConsole', () => {
  it('formats remote file checkpoint fields readably', () => {
    const v = {
      last_processed_file: '/data/a.ndjson',
      last_processed_mtime: '2024-01-01T00:00:00Z',
      last_processed_size: 42,
      last_processed_offset: 10,
      last_processed_hash: 'abc',
      last_success_event: { gdc_remote_path: '/data/a.ndjson' },
    }
    const out = formatCheckpointValueForConsole(v)
    expect(out).toContain('last_processed_file: /data/a.ndjson')
    expect(out).toContain('last_processed_mtime:')
    expect(out).toContain('last_processed_size: 42')
    expect(out).toContain('last_processed_offset: 10')
    expect(out).toContain('last_processed_hash: abc')
  })

  it('keeps S3-style checkpoints as compact JSON', () => {
    const v = {
      last_processed_key: 's3://bucket/obj.json',
      last_processed_last_modified: '2024-01-01T00:00:00Z',
      last_processed_etag: '"etag"',
      last_success_event: { s3_key: 'obj.json' },
    }
    const out = formatCheckpointValueForConsole(v)
    expect(out).toContain('last_processed_key:')
    expect(out).toContain('last_processed_last_modified:')
    expect(out).toContain('last_processed_etag:')
  })

  it('summarizes generic checkpoints with a reduced last event preview instead of raw JSON', () => {
    const v = {
      last_success_event: { event_id: 'evt-00140', timestamp: '2026-10-29T12:02:20Z', payload: { a: 1 } },
      cursor: '2026-10-29T12:02:20Z',
      value: '2026-10-29T12:02:20Z',
      last_seen: '2026-10-29T12:02:21Z',
    }
    const out = formatCheckpointValueForConsole(v)
    expect(out).toBe('last event: evt-00140 @ 2026-10-29T12:02:20Z\ncursor: 2026-10-29T12:02:20Z')
    expect(out).not.toContain('{')
  })

  it('lists cursor, last timestamp and a distinct value in a stable order', () => {
    const v = { value: 'v-9', last_timestamp: '2026-10-29T00:00:00Z', cursor: 'c-7' }
    expect(formatCheckpointValueForConsole(v)).toBe('cursor: c-7\nlast timestamp: 2026-10-29T00:00:00Z\nvalue: v-9')
  })

  it('formats a cursor-only checkpoint as readable text', () => {
    expect(formatCheckpointValueForConsole({ cursor: 'page-3' })).toBe('cursor: page-3')
  })

  it('keeps the em dash for missing checkpoints and compact JSON for an empty object', () => {
    expect(formatCheckpointValueForConsole(null)).toBe('—')
    expect(formatCheckpointValueForConsole(undefined)).toBe('—')
    expect(formatCheckpointValueForConsole({})).toBe('{}')
  })

  it('falls back to truncated compact JSON when no known keys exist', () => {
    const v = { custom: { nested: { deep: 'x'.repeat(200) } } }
    const out = formatCheckpointValueForConsole(v)
    expect(out.startsWith('{"custom":{"nested":')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(161)
  })

  it('does not print nested objects for known keys', () => {
    const v = { cursor: { page: 2 }, last_success_event: { meta: { id: 1 } }, other: 1 }
    expect(formatCheckpointValueForConsole(v)).toBe(JSON.stringify(v))
  })
})

describe('enrichStreamRowWithRuntime', () => {
  it('marks delivery percent as unknown when there are no delivery outcomes', () => {
    const base = streamReadToConsoleRow({
      id: 1,
      name: 's',
      connector_id: 1,
      source_id: 1,
      status: 'RUNNING',
    })
    const row = enrichStreamRowWithRuntime(
      base,
      {
        stream_id: 1,
        stream_status: 'RUNNING',
        checkpoint: null,
        summary: {
          total_logs: 1,
          route_send_success: 0,
          route_send_failed: 0,
          route_retry_success: 0,
          route_retry_failed: 0,
          route_skip: 0,
          source_rate_limited: 0,
          destination_rate_limited: 0,
          route_unknown_failure_policy: 0,
          run_complete: 1,
          processed_events: 10,
        },
        last_seen: { success_at: null, failure_at: null, rate_limited_at: null },
        routes: [],
        recent_logs: [],
      },
      null,
    )

    expect(row.events1h).toBe(10)
    expect(row.deliveryPct).toBe(0)
    expect(row.deliveryPctKnown).toBe(false)
  })
})
