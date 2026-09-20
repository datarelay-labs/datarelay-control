import { describe, expect, it } from 'vitest'
import { filterIanaTimezones, listIanaTimezones, timezoneSelectOptions } from './iana-timezones'

describe('iana-timezones', () => {
  it('lists practical IANA zones beyond the former four hard-coded options', () => {
    const zones = listIanaTimezones()
    expect(zones.length).toBeGreaterThan(4)
    expect(zones).toEqual(
      expect.arrayContaining(['UTC', 'Asia/Seoul', 'America/New_York', 'Europe/London', 'America/Los_Angeles', 'Europe/Berlin']),
    )
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
