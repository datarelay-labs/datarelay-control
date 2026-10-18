import { describe, expect, it } from 'vitest'
import { isStreamSchedulerActive, streamSchedulerActionLabel, streamSchedulerStatusLabel } from './stream-run-control-switch'

describe('stream-run-control-switch', () => {
  it('treats RUNNING, DEGRADED, and ERROR as scheduler active', () => {
    expect(isStreamSchedulerActive('RUNNING')).toBe(true)
    expect(isStreamSchedulerActive('DEGRADED')).toBe(true)
    expect(isStreamSchedulerActive('ERROR')).toBe(true)
    expect(isStreamSchedulerActive('STOPPED')).toBe(false)
    expect(isStreamSchedulerActive('UNKNOWN')).toBe(false)
  })

  it('labels active and stopped states clearly', () => {
    expect(streamSchedulerStatusLabel('RUNNING', true)).toBe('Running')
    expect(streamSchedulerStatusLabel('DEGRADED', true)).toBe('Running · degraded')
    expect(streamSchedulerStatusLabel('STOPPED', false)).toBe('Stopped')
    expect(streamSchedulerActionLabel(true)).toBe('Stop')
    expect(streamSchedulerActionLabel(false)).toBe('Start')
  })
})
