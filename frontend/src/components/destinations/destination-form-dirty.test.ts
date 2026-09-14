import { describe, expect, it } from 'vitest'
import { isDestinationFormDirty } from './destination-form-dirty'

describe('destination form dirty', () => {
  it('starts clean against baseline and becomes dirty on edit', () => {
    const baseline = { name: 'A', enabled: true }
    expect(isDestinationFormDirty(baseline, baseline)).toBe(false)
    expect(isDestinationFormDirty(baseline, { ...baseline, name: 'B' })).toBe(true)
    expect(isDestinationFormDirty(baseline, { name: 'A', enabled: true })).toBe(false)
  })
})
