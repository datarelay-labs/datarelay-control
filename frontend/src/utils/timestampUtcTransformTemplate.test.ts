import { describe, expect, it } from 'vitest'
import {
  buildTimestampUtcFieldJsonataExpression,
  buildTimestampUtcFullEventJsonataTemplate,
  jsonataPathFromJsonPath,
  suggestTimestampSourcePath,
} from './timestampUtcTransformTemplate'

describe('timestampUtcTransformTemplate', () => {
  it('converts JSONPath selections to JSONata paths', () => {
    expect(jsonataPathFromJsonPath('$.creationTime')).toBe('creationTime')
    expect(jsonataPathFromJsonPath('$.event.time')).toBe('event.time')
    expect(jsonataPathFromJsonPath('creationTime')).toBe('creationTime')
  })

  it('builds a per-field Timestamp → UTC expression for the selected source', () => {
    const expression = buildTimestampUtcFieldJsonataExpression('$.creationTime')
    expect(expression).toContain('creationTime')
    expect(expression).toContain('$fromMillis')
    expect(expression).toContain('$toMillis')
  })

  it('builds a full-event Timestamp → UTC merge template', () => {
    const template = buildTimestampUtcFullEventJsonataTemplate('$.event_time', 'event_time_utc')
    expect(template).toContain('$merge')
    expect(template).toContain('"event_time_utc"')
    expect(template).toContain('event_time')
    expect(template).toContain('$fromMillis')
  })

  it('suggests a timestamp-like source path when available', () => {
    expect(suggestTimestampSourcePath(['$.message', '$.creationTime', '$.host'])).toBe('$.creationTime')
    expect(suggestTimestampSourcePath(['$.message', '$.host'])).toBe('$.message')
  })
})
