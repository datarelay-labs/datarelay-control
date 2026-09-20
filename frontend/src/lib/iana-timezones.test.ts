import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalizeIanaTimezone,
  filterIanaTimezones,
  listIanaTimezones,
  timezoneSelectOptions,
} from './iana-timezones'

describe('iana-timezones', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists practical IANA zones beyond the former four hard-coded options', () => {
    const zones = listIanaTimezones()
    expect(zones.length).toBeGreaterThan(4)
    expect(zones).toEqual(
      expect.arrayContaining(['UTC', 'Asia/Seoul', 'America/New_York', 'Europe/London', 'America/Los_Angeles', 'Europe/Berlin']),
    )
  })

  it('maps ICU legacy aliases to ZoneInfo-compatible canonical identifiers', () => {
    expect(canonicalizeIanaTimezone('Asia/Calcutta')).toBe('Asia/Kolkata')
    expect(canonicalizeIanaTimezone('Europe/Kiev')).toBe('Europe/Kyiv')
    expect(canonicalizeIanaTimezone('America/Godthab')).toBe('America/Nuuk')
    expect(canonicalizeIanaTimezone('America/Los_Angeles')).toBe('America/Los_Angeles')
  })

  it('exposes canonical zones instead of ICU legacy aliases rejected by the API', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([
      'Asia/Calcutta',
      'Europe/Kiev',
      'America/Godthab',
      'America/New_York',
    ])

    const zones = listIanaTimezones()
    expect(zones).toEqual(
      expect.arrayContaining(['UTC', 'Asia/Kolkata', 'Europe/Kyiv', 'America/Nuuk', 'America/New_York']),
    )
    expect(zones).not.toContain('Asia/Calcutta')
    expect(zones).not.toContain('Europe/Kiev')
    expect(zones).not.toContain('America/Godthab')
  })

  it('filters by case-insensitive substring', () => {
    const zones = ['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Seoul']
    expect(filterIanaTimezones('los_angeles', zones)).toEqual(['America/Los_Angeles'])
    expect(filterIanaTimezones('  BERLIN ', zones)).toEqual(['Europe/Berlin'])
    expect(filterIanaTimezones('', zones)).toEqual(zones)
  })

  it('keeps the current value selectable when filtered out', () => {
    const zones = ['UTC', 'America/Los_Angeles', 'Europe/Berlin']
    expect(timezoneSelectOptions('Europe/Berlin', 'Los_Angeles', zones)).toEqual([
      'America/Los_Angeles',
      'Europe/Berlin',
    ])
  })
})
