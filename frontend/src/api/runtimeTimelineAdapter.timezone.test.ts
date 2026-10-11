import { afterEach, describe, expect, it } from 'vitest'
import { timelineItemsToRecentLogLines } from './runtimeTimelineAdapter'
import type { RuntimeTimelineItem } from './types/gdcApi'
import { setDisplayTimezoneCache } from '../lib/display-timezone-cache'
import { getTimezoneAbbreviation } from '../lib/platform-timestamps'

const sample = [{
  id: 7,
  created_at: '2026-10-10T18:00:00+09:00',
  level: 'INFO',
  status: 'SUCCESS',
  stage: 'route_send_success',
  message: 'Route delivery completed',
  latency_ms: 12,
}] as RuntimeTimelineItem[]

afterEach(() => {
  setDisplayTimezoneCache({ userTimezone: null, platformDefaultTimezone: null })
})

describe('Recent Stream event timeline time basis', () => {
  it('labels the user-configured timezone on recent events instead of an ambiguous clock', () => {
    setDisplayTimezoneCache({ userTimezone: 'UTC' })
    const [row] = timelineItemsToRecentLogLines(sample)
    expect(row.at).toBe('09:00:00 UTC')
  })

  it('labels the platform timezone when the user has not selected one', () => {
    setDisplayTimezoneCache({ userTimezone: null, platformDefaultTimezone: 'Asia/Seoul' })
    const [row] = timelineItemsToRecentLogLines(sample)
    expect(row.at).toBe(`18:00:00 ${getTimezoneAbbreviation('Asia/Seoul', new Date('2026-10-10T09:00:00Z'))}`)
  })
})
