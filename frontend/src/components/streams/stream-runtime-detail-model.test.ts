import { describe, expect, it } from 'vitest'
import { latestEventTimestamp, runHistoryRowKeys } from './stream-runtime-detail-model'

// C9: /streams/:id/runtime keyed run rows by `runId`, which repeats when metrics completion
// records share a run id, so React warned "two children with the same key". On the old code
// `runHistoryRowKeys` does not exist and the rows used the raw (duplicate) runId as key.
describe('runHistoryRowKeys (C9)', () => {
  it('returns one unique key per row when run ids repeat', () => {
    const rows = [
      { runId: 'run-1', idBasis: 'completion-record' as const },
      { runId: 'run-1', idBasis: 'completion-record' as const },
      { runId: 'run-2' },
      { runId: 'run-1', idBasis: 'completion-record' as const },
    ]
    const keys = runHistoryRowKeys(rows)
    expect(keys).toHaveLength(rows.length)
    expect(new Set(keys).size).toBe(rows.length)
  })

  it('keeps the same run id with a different id basis distinct', () => {
    const keys = runHistoryRowKeys([{ runId: '42', idBasis: 'run' }, { runId: '42', idBasis: 'completion-record' }])
    expect(new Set(keys).size).toBe(2)
  })

  it('is stable across recomputation and keeps unique ids unsuffixed', () => {
    const rows = [{ runId: 'a' }, { runId: 'b' }, { runId: 'a' }]
    expect(runHistoryRowKeys(rows)).toEqual(runHistoryRowKeys(rows))
    expect(runHistoryRowKeys(rows)).toEqual(['run:a', 'run:b', 'run:a#2'])
  })
})

describe('latestEventTimestamp (F-163)', () => {
  it('returns null when there is no delivery evidence', () => {
    expect(latestEventTimestamp(null, undefined)).toBeNull()
  })
  it('returns the newer of success and failure evidence', () => {
    expect(latestEventTimestamp('2026-10-31T16:00:00Z', '2026-10-31T16:05:00Z')).toBe('2026-10-31T16:05:00Z')
    expect(latestEventTimestamp('2026-10-31T16:10:00Z', '2026-10-31T16:05:00Z')).toBe('2026-10-31T16:10:00Z')
    expect(latestEventTimestamp('2026-10-31T16:10:00Z', null)).toBe('2026-10-31T16:10:00Z')
  })
})
