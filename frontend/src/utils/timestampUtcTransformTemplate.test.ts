import { describe, expect, it } from 'vitest'
import { collectSourcePathOptions } from './advancedTransformConfig'
import {
  TIMESTAMP_UTC_EPOCH_SECONDS_MAX,
  TIMESTAMP_UTC_JSONATA_GUIDANCE,
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

  it('quotes special/reserved key segments for safe JSONata field references', () => {
    expect(jsonataPathFromJsonPath('$.@timestamp')).toBe('`@timestamp`')
    expect(jsonataPathFromJsonPath('$.event.@timestamp')).toBe('event.`@timestamp`')
    // Hyphenated keys are produced by collectSourcePathOptions for real sample keys.
    expect(jsonataPathFromJsonPath('$.created-at')).toBe('`created-at`')
    expect(collectSourcePathOptions({ '@timestamp': '2024-01-01T00:00:00Z', 'created-at': 1700000000 })).toEqual(
      expect.arrayContaining(['$.@timestamp', '$.created-at']),
    )
  })

  it('builds a per-field Timestamp → UTC expression for the selected source', () => {
    const expression = buildTimestampUtcFieldJsonataExpression('$.creationTime')
    expect(expression).toContain('creationTime')
    expect(expression).toContain('$fromMillis')
    expect(expression).toContain('$toMillis')
    expect(expression).toContain(String(TIMESTAMP_UTC_EPOCH_SECONDS_MAX))
  })

  it('builds expressions that backtick-quote @timestamp selections', () => {
    const expression = buildTimestampUtcFieldJsonataExpression('$.@timestamp')
    expect(expression).toContain('`@timestamp`')
    expect(expression).not.toMatch(/(?<!`)@timestamp(?!`)/)
  })

  it('builds a full-event Timestamp → UTC merge template', () => {
    const template = buildTimestampUtcFullEventJsonataTemplate('$.event_time', 'event_time_utc')
    expect(template).toContain('$merge')
    expect(template).toContain('"event_time_utc"')
    expect(template).toContain('event_time')
    expect(template).toContain('$fromMillis')
  })

  it('describes the epoch seconds/milliseconds heuristic without claiming universal detection', () => {
    const guidance = TIMESTAMP_UTC_JSONATA_GUIDANCE.join(' ')
    expect(guidance).toContain(String(TIMESTAMP_UTC_EPOCH_SECONDS_MAX))
    expect(guidance).toMatch(/modern-era heuristic/i)
    expect(guidance).toMatch(/does not universally disambiguate/i)
  })

  it('suggests a timestamp-like source path when available', () => {
    expect(suggestTimestampSourcePath(['$.message', '$.creationTime', '$.host'])).toBe('$.creationTime')
    expect(suggestTimestampSourcePath(['$.message', '$.host'])).toBe('$.message')
    expect(suggestTimestampSourcePath(['$.message', '$.@timestamp'])).toBe('$.@timestamp')
  })
})
