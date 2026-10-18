import { describe, expect, it } from 'vitest'
import { buildSampleFieldCoverage } from './sample-field-coverage'

describe('bounded Record Selection sample field coverage', () => {
  it('counts nested and missing fields across only extracted sample events', () => {
    const result = buildSampleFieldCoverage([
      { id: 'one', user: { email: 'first@example.test' }, token: 'secret-1' },
      { id: 'two', user: { email: 'second@example.test' } },
      { id: 'two', user: {} },
    ])
    expect(result.examinedCount).toBe(3)
    expect(result.totalCount).toBe(3)
    expect(result.fields.find((row) => row.path === '$.user.email')).toMatchObject({
      presentCount: 2, distinctCount: 2,
    })
    expect(result.fields.find((row) => row.path === '$.id')).toMatchObject({
      presentCount: 3, distinctCount: 2,
    })
    expect(result.fields.find((row) => row.path === '$.token')?.presentCount).toBe(1)
  })

  it('reports empty and one-record samples without claiming full population data', () => {
    expect(buildSampleFieldCoverage([])).toMatchObject({ totalCount: 0, examinedCount: 0, fields: [] })
    const single = buildSampleFieldCoverage([{ name: 'private-value' }])
    expect(single.fields).toMatchObject([{ path: '$.name', presentCount: 1, distinctCount: 1 }])
  })

  it('caps sample event and field work explicitly', () => {
    const events = Array.from({ length: 80 }, (_, id) => Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => ['field' + index, id + index]),
    ))
    const result = buildSampleFieldCoverage(events)
    expect(result.totalCount).toBe(80)
    expect(result.examinedCount).toBe(20)
    expect(result.truncatedEvents).toBe(true)
    expect(result.fields.length).toBeLessThanOrEqual(50)
    expect(result.truncatedFields).toBe(true)
  })
})
