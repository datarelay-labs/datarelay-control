import { describe, expect, it } from 'vitest'
import { comparePreviewFields, formatPreviewValue } from './processing-preview-diff'

describe('M3-07 bounded actual-event field comparison', () => {
  it('distinguishes added, changed, removed and unchanged fields including explicit null', () => {
    const result = comparePreviewFields(
      { email: 'operator@example.test', user: { id: 1, obsolete: true }, keep: null },
      { email: 'o***@example.test', user: { id: 1 }, keep: null, classification: 'internal' },
    )
    expect(result.truncated).toBe(false)
    expect(result.rows.map(({ path, change }) => [path, change])).toEqual([
      ['$.classification', 'Added'], ['$.email', 'Changed'], ['$.keep', 'Unchanged'],
      ['$.user.id', 'Unchanged'], ['$.user.obsolete', 'Removed'],
    ])
    expect(result.counts).toEqual({ Added: 1, Changed: 1, Removed: 1, Unchanged: 2 })
  })

  it('does not confuse null, absence, numeric strings or literal dotted keys', () => {
    const result = comparePreviewFields({ 'a.b': null, number: 1, absent: null }, { 'a.b': null, number: '1', new: null })
    expect(result.rows.map(({ path, change }) => [path, change])).toEqual([
      ['$["a.b"]', 'Unchanged'], ['$.absent', 'Removed'], ['$.new', 'Added'], ['$.number', 'Changed'],
    ])
    expect(result.rows.find((row) => row.path === '$.new')).toMatchObject({ beforePresent: false, afterPresent: true, after: null })
  })

  it('ignores object key order but preserves array order and container type changes', () => {
    expect(comparePreviewFields({ b: 2, a: 1 }, { a: 1, b: 2 }).counts.Changed).toBe(0)
    const result = comparePreviewFields({ values: [1, 2], value: {} }, { values: [2, 1, null], value: [] })
    expect(result.rows.map(({ path, change }) => [path, change])).toEqual([
      ['$.value', 'Changed'], ['$.values[0]', 'Changed'], ['$.values[1]', 'Changed'], ['$.values[2]', 'Added'],
    ])
  })

  it('bounds rows without declaring omitted fields unchanged', () => {
    const before = Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`field${i}`, i]))
    const result = comparePreviewFields(before, before)
    expect(result.rows).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(result.counts.Unchanged).toBe(200)
  })

  it('bounds deep or circular data rather than hanging or inventing successful equality', () => {
    const circular: Record<string, unknown> = {}; circular.self = circular
    const result = comparePreviewFields(circular, circular)
    expect(result.truncated).toBe(true)
    expect(result.rows).toHaveLength(0)
    expect(formatPreviewValue(circular).text).toContain('omitted')
  })

  it('bounds long displayed values and reports the truncation explicitly', () => {
    const value = formatPreviewValue('x'.repeat(10000))
    expect(value.truncated).toBe(true)
    expect(value.text.length).toBeLessThanOrEqual(241)
    expect(formatPreviewValue(null)).toEqual({ text: 'null', truncated: false })
  })

  it('retains zero, false and empty objects as actual values', () => {
    const result = comparePreviewFields({ zero: 0, no: false, empty: {} }, { zero: 0, no: false, empty: {} })
    expect(result.counts.Unchanged).toBe(3)
    expect(result.truncated).toBe(false)
  })
})


describe('M3-01 existing evidence boundaries', () => {
  it('does not mutate frozen source/output samples or evaluate sample expressions', () => {
    const before = Object.freeze({ expression: '$eval("never execute")', value: Object.freeze([1, 2]) })
    const after = Object.freeze({ expression: '$eval("never execute")', value: Object.freeze([1, 3]) })
    expect(comparePreviewFields(before, after).counts).toEqual({ Added: 0, Changed: 1, Removed: 0, Unchanged: 2 })
    expect(before.value).toEqual([1, 2])
    expect(after.value).toEqual([1, 3])
  })

  it('handles prototype-like and markup field names as inert field data', () => {
    const before = JSON.parse('{"__proto__": {"admin": false}, "<img>": "literal"}')
    const after = JSON.parse('{"__proto__": {"admin": true}, "<img>": "literal"}')
    const result = comparePreviewFields(before, after)
    expect(result.rows.find((row) => row.path === '$.__proto__.admin')?.change).toBe('Changed')
    expect(formatPreviewValue(before).text).toContain('__proto__')
    expect(Object.hasOwn(Object.prototype, 'admin')).toBe(false)
  })
})
