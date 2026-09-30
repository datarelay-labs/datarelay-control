import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './bounded-async-map'

describe('mapWithConcurrency', () => {
  it('preserves result order while bounding concurrent work', async () => {
    let active = 0
    let maxActive = 0

    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 2 : 5))
      active -= 1
      return value * 10
    })

    expect(result).toEqual([10, 20, 30, 40, 50, 60])
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBeGreaterThan(1)
  })

  it('handles empty input and clamps invalid limits to one worker', async () => {
    expect(await mapWithConcurrency([], 4, async (value: number) => value)).toEqual([])

    let active = 0
    let maxActive = 0
    const result = await mapWithConcurrency([1, 2, 3], 0, async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return value
    })

    expect(result).toEqual([1, 2, 3])
    expect(maxActive).toBe(1)
  })
})
