import { describe, expect, it } from 'vitest'
import { safeOperationalResourceId } from './logs-console-helpers'

describe('Logs Explorer manually supplied resource ID parser', () => {
  it('preserves valid positive safe integers', () => {
    expect(safeOperationalResourceId('42')).toBe(42)
    expect(safeOperationalResourceId('00042')).toBe(42)
    expect(safeOperationalResourceId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([null, undefined, '', '0', '-1', '1.5', ' 42 ', '1e5', 'NaN', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1)])(
    'ignores invalid ID %s instead of silently narrowing delivery results',
    (raw) => expect(safeOperationalResourceId(raw)).toBeUndefined(),
  )
})
