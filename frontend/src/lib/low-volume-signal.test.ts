import { describe, expect, it } from 'vitest'
import {
  LOW_VOLUME_EVENT_THRESHOLD_PER_HOUR,
  estimatedHourlyEventsFromEps,
  isLowVolumeEps,
  isLowVolumeHourlyEvents,
} from './low-volume-signal'

describe('low-volume signal contract', () => {
  it('projects snapshot EPS to the same hourly estimate used by Stream Console', () => {
    expect(estimatedHourlyEventsFromEps(0.01, 0.02)).toBe(36)
    expect(estimatedHourlyEventsFromEps(0, 0.02)).toBe(72)
    expect(estimatedHourlyEventsFromEps(0, 0)).toBe(0)
  })

  it('excludes zero traffic and the threshold boundary', () => {
    expect(isLowVolumeHourlyEvents(0)).toBe(false)
    expect(isLowVolumeHourlyEvents(LOW_VOLUME_EVENT_THRESHOLD_PER_HOUR - 1)).toBe(true)
    expect(isLowVolumeHourlyEvents(LOW_VOLUME_EVENT_THRESHOLD_PER_HOUR)).toBe(false)
  })

  it('does not confuse high-volume degradation with Low Volume', () => {
    expect(isLowVolumeEps(20, 20)).toBe(false)
    expect(isLowVolumeEps(0.01, 0.01)).toBe(true)
  })
})
