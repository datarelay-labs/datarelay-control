import { resolveJsonPath } from '../stream-api-test-json-utils'
import { flattenSampleFields } from './wizard-json-extract'

export const SAMPLE_FIELD_COVERAGE_MAX_EVENTS = 20
export const SAMPLE_FIELD_COVERAGE_MAX_FIELDS = 50
const MAX_SAMPLE_DEPTH = 4
const MAX_DISTINCT_VALUE_CHARS = 128

export type SampleFieldCoverageRow = {
  path: string
  presentCount: number
  distinctCount: number
}

export type SampleFieldCoverage = {
  totalCount: number
  examinedCount: number
  truncatedEvents: boolean
  truncatedFields: boolean
  fields: SampleFieldCoverageRow[]
}

/** Bounded local sample evidence, never emit sample values or infer whole-production coverage. */
export function buildSampleFieldCoverage(events: readonly Record<string, unknown>[]): SampleFieldCoverage {
  const examined = events.slice(0, SAMPLE_FIELD_COVERAGE_MAX_EVENTS)
  const counts = new Map<string, { presentCount: number; distinct: Set<string> }>()
  let truncatedFields = false

  for (const event of examined) {
    const paths = flattenSampleFields(event, SAMPLE_FIELD_COVERAGE_MAX_FIELDS + 1, MAX_SAMPLE_DEPTH)
    if (paths.length > SAMPLE_FIELD_COVERAGE_MAX_FIELDS) truncatedFields = true
    for (const path of new Set(paths)) {
      if (!counts.has(path)) {
        if (counts.size >= SAMPLE_FIELD_COVERAGE_MAX_FIELDS) {
          truncatedFields = true
          continue
        }
        counts.set(path, { presentCount: 0, distinct: new Set() })
      }
      const row = counts.get(path)!
      const value = resolveJsonPath(event, path)
      if (value === undefined) continue
      row.presentCount += 1
      // Distinct counts are approximate because long strings are bounded;
      // do not store or display any sample payload in the rendered summary.
      if (value === null) row.distinct.add('null')
      else if (typeof value === 'string') row.distinct.add('s:' + value.slice(0, MAX_DISTINCT_VALUE_CHARS))
      else if (typeof value === 'number' || typeof value === 'boolean') row.distinct.add(typeof value + ':' + value)
    }
  }

  return {
    totalCount: events.length,
    examinedCount: examined.length,
    truncatedEvents: events.length > SAMPLE_FIELD_COVERAGE_MAX_EVENTS,
    truncatedFields,
    fields: Array.from(counts, ([path, row]) => ({
      path,
      presentCount: row.presentCount,
      distinctCount: row.distinct.size,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  }
}
