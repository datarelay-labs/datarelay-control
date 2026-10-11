import { describe, expect, it } from 'vitest'
import { formatLogTimeUtc } from './logs-console-helpers'

describe('Operational log timestamp basis', () => {
  it('normalizes explicit offset instants into one UTC basis', () => {
    expect(formatLogTimeUtc('2026-10-10T09:00:00Z')).toBe('2026-10-10 09:00:00.000 UTC')
    expect(formatLogTimeUtc('2026-10-10T18:00:00+09:00')).toBe('2026-10-10 09:00:00.000 UTC')
    expect(formatLogTimeUtc('2026-10-10T04:00:00-05:00')).toBe('2026-10-10 09:00:00.000 UTC')
  })

  it('does not invent UTC for an input without a verified timezone', () => {
    expect(formatLogTimeUtc('2026-10-10T09:00:00')).toBe('Time basis unavailable')
    expect(formatLogTimeUtc('')).toBe('Time basis unavailable')
    expect(formatLogTimeUtc('not-a-timeZ')).toBe('Time basis unavailable')
  })

  it('marks invalid but zoned timestamps unavailable', () => {
    expect(formatLogTimeUtc('2026-99-99T09:00:00Z')).toBe('Timestamp unavailable')
  })
})
