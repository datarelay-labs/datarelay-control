import { describe, expect, it } from 'vitest'
import { runtimePreviewBadgeLabel, summarizeTransformFailures } from './route-processing-transform-failures'

const ok = { success: true, error_code: null, error_message: null, output_field: 'a' }

describe('summarizeTransformFailures (F-152 / F-172 / F-235)', () => {
  it('ignores successful rules', () => {
    expect(summarizeTransformFailures([ok])).toEqual({ count: 0, engineUnavailable: false, lines: [] })
  })

  it('flags TRANSFORM_ENGINE_UNAVAILABLE and dedupes identical failures across events', () => {
    const failed = {
      success: false,
      error_code: 'TRANSFORM_ENGINE_UNAVAILABLE',
      error_message: 'JSONata engine is not installed in the runtime environment.',
      output_field: 'jn_label',
    }
    const summary = summarizeTransformFailures([failed, failed, ok])
    expect(summary.count).toBe(1)
    expect(summary.engineUnavailable).toBe(true)
    expect(summary.lines[0].field).toBe('jn_label')
  })

  it('reports a calculated rule that could not be evaluated', () => {
    const summary = summarizeTransformFailures([
      { success: false, error_code: 'CALCULATED_EXPRESSION_FAILED', error_message: "Unsupported token '$ b'", output_field: 'sev' },
    ])
    expect(summary.count).toBe(1)
    expect(summary.engineUnavailable).toBe(false)
    expect(summary.lines[0].message).toContain('Unsupported token')
  })
})

describe('runtimePreviewBadgeLabel', () => {
  const base = { loading: false, error: null, hasPreview: true, failureCount: 0 }
  it('only says verified when no rule failed', () => {
    expect(runtimePreviewBadgeLabel(base)).toBe('Runtime verified')
    expect(runtimePreviewBadgeLabel({ ...base, failureCount: 2 })).toBe('2 rules failed')
    expect(runtimePreviewBadgeLabel({ ...base, failureCount: 1 })).toBe('1 rule failed')
  })
  it('keeps loading, error and pending states', () => {
    expect(runtimePreviewBadgeLabel({ ...base, loading: true })).toBe('Runtime preview')
    expect(runtimePreviewBadgeLabel({ ...base, error: 'x' })).toBe('Preview failed')
    expect(runtimePreviewBadgeLabel({ ...base, hasPreview: false })).toBe('Preview pending')
  })
})
